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
@MainActor
final class PlayHistoryStore {
    private let core: SharedCore
    private let fileURL: URL
    private var items: [[String: Any]] = []
    private var tail: Task<Void, Never> = Task {}

    init(core: SharedCore, directory: URL) {
        self.core = core
        fileURL = directory.appendingPathComponent("play-history.json")
        if let data = try? Data(contentsOf: fileURL), let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], object["version"] as? Int == 1 {
            items = object["items"] as? [[String: Any]] ?? []
        }
    }

    /// 1回の再生を足す。順に1つずつ行う（await の間に、古い内容で上書きしないため）。
    func add(key: String) async {
        let previous = tail
        let mine = Task { @MainActor in
            await previous.value
            let request: [String: Any] = ["items": items, "key": key, "at": (Date().timeIntervalSince1970 * 1000).rounded()]
            guard let text = try? String(decoding: JSONSerialization.data(withJSONObject: request), as: UTF8.self),
                  let reply = try? await core.callAsync("HistoryAdd", text),
                  let object = (try? JSONSerialization.jsonObject(with: Data(reply.utf8))) as? [String: Any], let next = object["items"] as? [[String: Any]] else { return }
            items = next
            save()
        }
        tail = mine
        await mine.value
    }

    /// 最近聴いた曲のキー（新しい順。同じ曲は1つ）。
    func keys(limit: Int) async -> [String] {
        let request: [String: Any] = ["items": items, "limit": limit]
        guard let text = try? String(decoding: JSONSerialization.data(withJSONObject: request), as: UTF8.self),
              let reply = try? await core.callAsync("HistoryKeys", text),
              let object = (try? JSONSerialization.jsonObject(with: Data(reply.utf8))) as? [String: Any] else { return [] }
        return object["keys"] as? [String] ?? []
    }

    func clear() {
        items = []
        try? FileManager.default.removeItem(at: fileURL)
    }

    private func save() {
        try? AtomicJsonFile.writeJSONObject(["version": 1, "items": items], to: fileURL)
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
