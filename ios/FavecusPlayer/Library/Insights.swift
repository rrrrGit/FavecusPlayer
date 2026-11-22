import Foundation

// 再生履歴・自動リストの設定・再生統計（v0.7.4）。規則は共通JS（core/play-history.cjs・auto-list-settings.cjs・play-ledger.cjs の Stats。PC版と同じ）。
// この端末内だけに保存し、同期しない。Application Support/FavecusPlayer に、原子的に書く。

/// 自動リストの設定（件数・条件）。選択肢は、PC版・共通JS（auto-list-settings.cjs）と同じ。知らない値は、いちばん近い選択肢にする。
struct AutoListSettings: Codable, Equatable {
    static let limitChoices = [10, 20, 50, 100, 200, 500]
    static let frequentMinChoices = [1, 2, 3, 5, 10]
    static let recentDaysChoices = [0, 7, 30, 90, 365]
    static let kinds = ["frequent", "recent", "unplayed", "favorites", "history"]
    static let defaultLimits = ["frequent": 50, "recent": 50, "unplayed": 200, "favorites": 200, "history": 100]

    var limits: [String: Int] = AutoListSettings.defaultLimits
    var frequentMin = 1
    var recentDays = 0

    private static func nearest(_ choices: [Int], _ value: Int, fallback: Int) -> Int {
        choices.min { abs($0 - value) < abs($1 - value) } ?? fallback
    }

    func normalized() -> AutoListSettings {
        var result = AutoListSettings()
        for kind in Self.kinds { result.limits[kind] = Self.nearest(Self.limitChoices, limits[kind] ?? Self.defaultLimits[kind] ?? 50, fallback: Self.defaultLimits[kind] ?? 50) }
        result.frequentMin = Self.nearest(Self.frequentMinChoices, frequentMin, fallback: 1)
        result.recentDays = Self.nearest(Self.recentDaysChoices, recentDays, fallback: 0)
        return result
    }

    static func listName(_ kind: String) -> String {
        ["frequent": "よく聴く曲", "recent": "最近追加した曲", "unplayed": "未再生", "favorites": "お気に入り", "history": "最近聴いた曲"][kind] ?? kind
    }
}

@MainActor
final class AutoListSettingsStore: ObservableObject {
    private struct Document: Codable { var version: Int; var settings: AutoListSettings }
    @Published private(set) var settings = AutoListSettings()
    private let fileURL: URL

    init(directory: URL? = nil) {
        fileURL = (directory ?? AtomicJsonFile.defaultDirectory()).appendingPathComponent("auto-list-settings.json")
        if let document = AtomicJsonFile.readOptional(Document.self, from: fileURL), document.version == 1 {
            settings = document.settings.normalized()
        }
    }

    func set(_ next: AutoListSettings) {
        settings = next.normalized()
        try? AtomicJsonFile.write(Document(version: 1, settings: settings), to: fileURL)
    }
}

/// 再生履歴（最近聴いた曲）。数え方は、再生回数と同じ（実再生の3秒など）。新しいものが先頭・最大500件・同じ曲が1分以内に続いたら1回。
/// ローカル曲は端末内のみ、Bilibili曲・削除時刻は同期する（v0.7.5。規則は共通JS：src/core/play-history.cjs）。
@MainActor
final class PlayHistoryStore: ObservableObject {
    @Published private(set) var revision = 0
    private let core: SharedCore
    private let fileURL: URL
    private var text = ""
    private var dirty: Set<String> = []
    private var dirtyCleared = false
    private var inFlight: Set<String> = []
    private var inFlightCleared = false
    private var touched: Set<String> = []
    private var touchedCleared = false
    private var pushedOnce = false
    private var tail: Task<Void, Never> = Task {}
    var onChange: (() -> Void)?

    init(core: SharedCore, directory: URL) {
        self.core = core
        fileURL = directory.appendingPathComponent("play-history.json")
        text = open()
    }

    private func open() -> String {
        if let stored = (try? Data(contentsOf: fileURL)).flatMap({ String(data: $0, encoding: .utf8) }),
           let opened = try? Self.object(core.call("HistoryOpen", Self.json(["text": stored]))),
           let normalized = opened["text"] as? String {
            return normalized
        }
        let created = (try? Self.object(core.call("HistoryOpen", "{}"))) ?? [:]
        return (created["text"] as? String) ?? "{\"version\":1,\"items\":[],\"clearedAt\":0,\"syncCursor\":0}"
    }

    private func persist() {
        guard !text.isEmpty else { return }
        do {
            try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(text.utf8).write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {}
    }

    private func enqueue(_ work: @escaping @MainActor () async -> Void) {
        let previous = tail
        tail = Task { @MainActor in
            _ = await previous.value
            await work()
        }
    }

    private func serialized<T>(_ work: @escaping @MainActor () async -> T) async -> T {
        let previous = tail
        let mine = Task { @MainActor () -> T in
            _ = await previous.value
            return await work()
        }
        tail = Task { @MainActor in _ = await mine.value }
        return await mine.value
    }

    /// 1回の再生を足す。順に1つずつ行う（await の間に、古い内容で上書きしないため）。
    func add(key: String) async {
        await serialized { [self] in
            guard let reply = try? await core.callAsync("HistoryAddState", Self.json(["text": text, "key": key, "at": Self.nowMs()])),
                  let object = try? Self.object(reply), let next = object["text"] as? String else { return }
            text = next
            persist()
            revision += 1
            if object["syncable"] as? Bool == true {
                dirty.insert(key)
                if inFlight.contains(key) { touched.insert(key) }
                onChange?()
            }
        }
    }

    /// 最近聴いた曲のキー（新しい順。同じ曲は1つ）。
    func keys(limit: Int) async -> [String] {
        await serialized { [self] () async -> [String] in
            guard let current = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any],
                  let items = current["items"] as? [[String: Any]],
                  let reply = try? await core.callAsync("HistoryKeys", Self.json(["items": items, "limit": limit])),
                  let object = try? Self.object(reply) else { return [] }
            return object["keys"] as? [String] ?? []
        }
    }

    func clear() {
        enqueue { [self] in await clearSerialized() }
    }

    func clearAndWait() async {
        await serialized { [self] in await clearSerialized() }
    }

    private func clearSerialized() async {
        guard let reply = try? await core.callAsync("HistoryClear", Self.json(["text": text, "now": Self.nowMs()])),
              let object = try? Self.object(reply), let next = object["text"] as? String else { return }
        text = next
        persist()
        dirty.removeAll()
        touched.removeAll()
        dirtyCleared = true
        if inFlightCleared { touchedCleared = true }
        revision += 1
        onChange?()
    }

    // MARK: 同期（sync-counts.cjs の history アダプター）

    func syncRead(deviceId: String) async -> String? {
        await serialized { [self] () async -> String? in
            let filterKeys: Any = pushedOnce ? Array(dirty) : NSNull()
            guard let reply = try? await core.callAsync("HistorySyncState", Self.json(["text": text, "keys": filterKeys])),
                  var state = try? Self.object(reply) else { return nil }
            let rows = state["rows"] as? [[String: Any]] ?? []
            inFlight = Set(rows.compactMap { $0["key"] as? String })
            touched = []
            inFlightCleared = dirtyCleared
            touchedCleared = false
            state["deviceId"] = deviceId
            return Self.json(state)
        }
    }

    func syncApply(_ json: String) async {
        guard let value = try? Self.object(json) else { return }
        await serialized { [self] in
            let request: [String: Any] = ["text": text, "rows": value["rows"] ?? [], "clearedAt": value["clearedAt"] ?? 0, "cursor": value["cursor"] ?? 0, "now": Self.nowMs()]
            guard let reply = try? await core.callAsync("HistoryMerge", Self.json(request)),
                  let merged = try? Self.object(reply), let next = merged["text"] as? String else { return }
            if merged["changed"] as? Bool == true {
                text = next
                persist()
                if merged["itemsChanged"] as? Bool == true { revision += 1 }
            }
        }
    }

    func syncPushed() {
        for key in inFlight where !touched.contains(key) { dirty.remove(key) }
        if inFlightCleared && !touchedCleared { dirtyCleared = false }
        inFlight = []
        touched = []
        inFlightCleared = false
        touchedCleared = false
        pushedOnce = true
    }

    func resetSync() {
        enqueue { [self] in
            if var obj = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] {
                obj["syncCursor"] = 0
                text = Self.json(obj)
                persist()
            }
            dirty.removeAll()
            dirtyCleared = false
            inFlight.removeAll()
            inFlightCleared = false
            touched.removeAll()
            touchedCleared = false
            pushedOnce = false
        }
    }

    private static func nowMs() -> Double { (Date().timeIntervalSince1970 * 1000).rounded() }

    private static func json(_ object: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object), let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text
    }

    private static func object(_ text: String) throws -> [String: Any] {
        guard let object = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else { throw SharedCoreError.invalidResult("object") }
        if let message = object["error"] as? String { throw SharedCoreError.script(message) }
        return object
    }
}

/// 再生統計の1行（曲名と回数）。
struct StatsSong: Equatable, Identifiable {
    let id = UUID()
    let title: String
    let count: Int
}

struct StatsMonth: Equatable, Identifiable {
    let month: String
    let plays: Int
    var seconds: Int = 0
    var id: String { month }
}

/// 再生統計（共通JSの LedgerStats ＝ PC版と同じ規則）。
struct PlayStats: Equatable {
    var total = 0
    var totalSeconds = 0
    var months: [StatsMonth] = []
    var top: [StatsSong] = []
    var thisMonthTop: [StatsSong] = []
}

/// 月ごとの再生時間（バックグラウンド再生を含む。この端末内だけ、Application Support/FavecusPlayer/play-time.json に保存）。
@MainActor
final class PlayTimeStore {
    private struct Document: Codable { var version: Int; var months: [String: Double] }
    private let fileURL: URL
    private var months: [String: Double] = [:]
    private var lastPosition: Double?
    private var lastAt: Date?
    private var wasPlaying = false
    private var lastFlush: Date = .distantPast
    private var dirty = false
    static let maxElapsed: Double = 60
    static let maxMonths = 120
    static let flushInterval: TimeInterval = 10
    private static let jst = TimeZone(secondsFromGMT: 9 * 3600)!

    init(directory: URL? = nil) {
        fileURL = (directory ?? AtomicJsonFile.defaultDirectory()).appendingPathComponent("play-time.json")
        if let document = AtomicJsonFile.readOptional(Document.self, from: fileURL), document.version == 1 {
            months = Self.clean(document.months)
        }
    }

    private static func monthOf(_ date: Date) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = jst
        let c = calendar.dateComponents([.year, .month], from: date)
        return String(format: "%04d-%02d", c.year ?? 1970, c.month ?? 1)
    }

    private static func clean(_ raw: [String: Double]) -> [String: Double] {
        let valid = raw.filter { key, value in
            key.range(of: #"^\d{4}-(?:0[1-9]|1[0-2])$"#, options: .regularExpression) != nil && value.isFinite && value >= 0
        }
        if valid.count <= maxMonths { return valid }
        return Dictionary(uniqueKeysWithValues: valid.sorted { $0.key < $1.key }.suffix(maxMonths))
    }

    func begin(now: Date = Date()) {
        lastPosition = nil
        lastAt = now
        wasPlaying = false
    }

    func stop() {
        flush()
        lastPosition = nil
        lastAt = nil
        wasPlaying = false
    }

    func observe(position: Double, paused: Bool, rate: Double = 1, now: Date = Date()) {
        guard position.isFinite else { return }
        if lastAt == nil { begin(now: now) }
        let previousPosition = lastPosition ?? position
        let elapsed = now.timeIntervalSince(lastAt ?? now)
        let delta = position - previousPosition
        if wasPlaying && elapsed > 0 && elapsed <= Self.maxElapsed && delta > 0 && delta <= elapsed * max(1, rate) + 2.0 {
            let month = Self.monthOf(now)
            months[month, default: 0] += min(delta, elapsed)
            if months.count > Self.maxMonths { months = Self.clean(months) }
            dirty = true
        }
        let becamePaused = paused && wasPlaying
        lastPosition = position
        lastAt = now
        wasPlaying = !paused
        if dirty && (becamePaused || now.timeIntervalSince(lastFlush) >= Self.flushInterval) {
            flush(now: now)
        }
    }

    func flush(now: Date = Date()) {
        guard dirty else { return }
        dirty = false
        lastFlush = now
        try? AtomicJsonFile.write(Document(version: 1, months: months), to: fileURL)
    }

    func stats(months count: Int = 12, now: Date = Date()) -> (totalSeconds: Int, byMonth: [String: Int]) {
        let totalSeconds = Int(months.values.reduce(0, +).rounded())
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = Self.jst
        let c = calendar.dateComponents([.year, .month], from: now)
        let baseYear = c.year ?? 1970, baseMonth = c.month ?? 1
        let span = max(1, min(60, count))
        var byMonth: [String: Int] = [:]
        for back in 0..<span {
            let idx = baseYear * 12 + (baseMonth - 1) - back
            let year = Int(floor(Double(idx) / 12.0))
            let month = ((idx % 12) + 12) % 12 + 1
            let key = String(format: "%04d-%02d", year, month)
            byMonth[key] = Int((months[key] ?? 0).rounded())
        }
        return (totalSeconds, byMonth)
    }

    static func formatDuration(_ seconds: Int) -> String {
        let s = max(0, seconds)
        if s == 0 { return "0分" }
        if s < 60 { return "\(s)秒" }
        let minutes = s / 60, hours = minutes / 60, rem = minutes % 60
        if hours == 0 { return "\(minutes)分" }
        return rem > 0 ? "\(hours)時間\(rem)分" : "\(hours)時間"
    }
}
