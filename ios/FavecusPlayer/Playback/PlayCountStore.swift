import Foundation

/// 再生回数の台帳の保存と操作。数え方（実再生3秒で1回など）・合計・世代（リセット）・抽選の重みの規則は、Windows版と共通のJS（FavecusCore.Ledger*・Play*）。
/// Swiftは、台帳（JSON文字列）のファイルへの保存と、共通JSの呼び出しだけを行う。同期するのはBilibiliの曲の行だけ（ローカルの曲は、この端末の中だけ）。
/// 数える処理は、同期が無効でも動く。
@MainActor
final class PlayCountStore: ObservableObject {
    @Published private(set) var revision = 0
    private let core: SharedCore
    private let file: URL
    private let defaults: UserDefaults
    private let aliasesProvider: (() -> [[String: String]])?
    private var text: String
    private(set) var deviceId = ""
    /// 起動後に変わった自分の行（同期へ送る）。起動後の最初の同期では、すべての行を送る。
    private var dirty: Set<String> = []
    private var inFlight: Set<String> = []
    private var touched: Set<String> = []
    private var pushedOnce = false
    /// 台帳を書き換える処理は、1つずつ順に行う（await の間に別の処理が割り込んで、古い内容で上書きしないように）。
    private var tail: Task<Void, Never> = Task {}
    private var playChain: Task<Void, Never>?
    private var playToken: UUID?
    private var observing = false
    /// 台帳を読めず、元のファイルを別名で残して作り直したときの知らせ。
    private(set) var notice: String?
    /// 回数を数えたとき（再生履歴へ足すため）。曲のキー。
    var onCounted: ((String) -> Void)?
    /// 同期対象の変更（再生回数の加算・リセット）が起きたとき。
    var onChange: (() -> Void)?

    static let weightedKey = "weightedShuffle"
    static let weightedAtKey = "weightedShuffleAt"

    init(core: SharedCore, directory: URL, defaults: UserDefaults = .standard, aliasesProvider: (() -> [[String: String]])? = nil) {
        self.core = core
        self.file = directory.appendingPathComponent("play-ledger.json")
        self.defaults = defaults
        self.aliasesProvider = aliasesProvider
        text = ""
        text = open()
        if let state = try? Self.object(core.call("LedgerSyncState", Self.json(["text": text]))),
           let id = state["deviceId"] as? String {
            deviceId = id
        }
    }

    // MARK: 設定（「再生回数が少ない曲を優先する」。同期では、新しい変更が勝つ）

    var weighted: Bool { defaults.object(forKey: Self.weightedKey) as? Bool ?? true }
    var weightedAt: Double { defaults.double(forKey: Self.weightedAtKey) }

    /// 利用者が変えたとき（変更時刻を付ける）。
    func setWeighted(_ value: Bool) {
        defaults.set(value, forKey: Self.weightedKey)
        defaults.set((Date().timeIntervalSince1970 * 1000).rounded(), forKey: Self.weightedAtKey)
        onChange?()
    }

    // MARK: 台帳

    private func open() -> String {
        let stored = (try? Data(contentsOf: file)).flatMap { String(data: $0, encoding: .utf8) }
        let deviceId = String(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(16))
        if let stored, let opened = try? Self.object(core.call("LedgerOpen", Self.json(["text": stored]))), let normalized = opened["text"] as? String {
            return normalized
        }
        if stored != nil {
            // 読めない台帳は、上書きせず別名で残して、0から数え直す
            let aside = file.deletingLastPathComponent().appendingPathComponent("play-ledger.damaged-\(Int(Date().timeIntervalSince1970)).json")
            try? FileManager.default.moveItem(at: file, to: aside)
            notice = "再生回数を読み込めませんでした。元の記録は残し、回数を0から記録します。"
        }
        let created = (try? Self.object(core.call("LedgerOpen", Self.json(["deviceId": deviceId])))) ?? [:]
        return (created["text"] as? String) ?? ""
    }

    private func persist() {
        guard !text.isEmpty else { return }
        do {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(text.utf8).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {}
    }

    private func currentAliases() -> [[String: String]] { aliasesProvider?() ?? [] }

    /// 曲のキー → 抽選の重み（1/(1+回数)。お気に入りは倍率つき。共通JS）。
    func weights(for keys: [String], favorites: Set<String> = []) async -> [String: Double] {
        guard !text.isEmpty, !keys.isEmpty,
              let result = try? await call("LedgerCounts", ["text": text, "keys": keys, "favorites": Array(favorites), "aliases": currentAliases()]), let weights = result["weights"] as? [String: Double] else { return [:] }
        return weights
    }

    /// 曲のキー → 再生回数（共通JS）。自動リストの選び方に使う。
    func counts(for keys: [String]) async -> [String: Int] {
        guard !text.isEmpty, !keys.isEmpty,
              let result = try? await call("LedgerCounts", ["text": text, "keys": keys, "aliases": currentAliases()]), let counts = result["counts"] as? [String: Int] else { return [:] }
        return counts
    }

    func count(for key: String) async -> Int {
        guard !text.isEmpty, let result = try? await call("LedgerCounts", ["text": text, "keys": [key], "aliases": currentAliases()]), let counts = result["counts"] as? [String: Int] else { return 0 }
        return counts[key] ?? 0
    }

    // MARK: 再生を数える

    /// 曲の再生を始めた（keyがnilの曲は数えない）。
    func begin(key: String?) async {
        await serializedPlay { [self] in
            _ = try? await call("PlayBegin", ["key": key ?? "", "now": Self.nowMs()])
        }
    }

    /// 再生の統計（共通JSの LedgerStats ＝ PC版と同じ規則）。{ total, months, top[{key,count}], thisMonthTop }。
    func stats() async -> [String: Any]? {
        guard !text.isEmpty, let result = try? await call("LedgerStats", ["text": text, "topLimit": 20, "months": 12, "nowMs": Self.nowMs(), "aliases": currentAliases()]), result["error"] == nil else { return nil }
        return result
    }

    func stop() async {
        await serializedPlay { [self] in
            _ = try? await call("PlayStop", [:])
        }
    }

    /// 再生位置を知らせる。数え終えたとき（実再生3秒など）、この端末の行を1つ増やす。
    /// 定期の確認で通信・判定が重なったときは飛ばすが、曲終了（ended == true）は完了を待って必ず判定する。
    func observe(position: Double, duration: Double, paused: Bool, ended: Bool = false, playbackRate: Double = 1) async {
        if !ended, observing { return }
        await serializedPlay { [self] in
            let media: [String: Any] = ["position": position, "duration": duration, "paused": paused, "ended": ended, "playbackRate": playbackRate]
            guard let result = try? await call("PlayObserve", ["media": media, "now": Self.nowMs()]), let key = result["key"] as? String else { return }
            await increment(key: key)
        }
    }

    private func serializedPlay(_ work: @escaping @MainActor () async -> Void) async {
        observing = true
        let token = UUID()
        playToken = token
        let previous = playChain
        let mine = Task { @MainActor in
            await previous?.value
            await work()
        }
        playChain = mine
        await mine.value
        if playToken == token {
            observing = false
            playChain = nil
        }
    }

    private func enqueue(_ work: @escaping @MainActor () async -> Void) {
        let previous = tail
        tail = Task { @MainActor in
            await previous.value
            await work()
        }
    }

    private func serialized<T>(_ work: @escaping @MainActor () async -> T) async -> T {
        let previous = tail
        let mine = Task { @MainActor () -> T in
            await previous.value
            return await work()
        }
        tail = Task { @MainActor in _ = await mine.value }
        return await mine.value
    }

    func increment(key: String) async {
        await serialized { [self] in
            guard !text.isEmpty, let result = try? await call("LedgerIncrement", ["text": text, "key": key, "now": Self.nowMs()]),
                  let next = result["text"] as? String else { return }
            text = next
            persist()
            revision += 1
            onCounted?(key)
            if let row = result["row"] as? [String: Any], let id = row["id"] as? String, key.hasPrefix("bili") {
                dirty.insert(id)
                if inFlight.contains(id) { touched.insert(id) } // 今回の同期の読み取りのあとに変わった行：送信後も、印を残す
                onChange?()
            }
        }
    }

    /// リセット：世代を1つ上げる（古い世代の行は、履歴として残る）。他の端末へは、次の同期で届く。
    func reset() async {
        await serialized { [self] in
            guard !text.isEmpty, let result = try? await call("LedgerReset", ["text": text]), let next = result["text"] as? String else { return }
            text = next
            persist()
            revision += 1
        }
        await stop()
        onChange?()
    }

    // MARK: 同期（sync-counts.cjs のアダプター。JSの host から呼ばれる）

    /// { deviceId, epoch, cursor, rows（送る行）, prefs } のJSON文字列。
    func syncRead() async -> String? {
        await serialized { [self] () async -> String? in
            guard !text.isEmpty, var state = try? await call("LedgerSyncState", ["text": text]) else { return nil }
            let rows = (state["rows"] as? [[String: Any]] ?? []).filter { !pushedOnce || dirty.contains($0["id"] as? String ?? "") }
                .map { ["epoch": $0["epoch"] ?? 0, "month": $0["month"] ?? "", "key": $0["key"] ?? "", "n": $0["n"] ?? 1] as [String: Any] }
            inFlight = Set((state["rows"] as? [[String: Any]] ?? []).filter { !pushedOnce || dirty.contains($0["id"] as? String ?? "") }.compactMap { $0["id"] as? String })
            touched = []
            state["rows"] = rows
            state["prefs"] = ["weighted": weighted, "at": weightedAt]
            return Self.json(state)
        }
    }

    /// 他の端末から受け取った行・世代・読み取り位置・設定を取り込む。
    func syncApply(_ json: String) async {
        guard let value = try? Self.object(json) else { return }
        var didChange = false
        await serialized { [self] in
            guard !text.isEmpty else { return }
            var request: [String: Any] = ["text": text, "rows": value["rows"] ?? [], "cursor": value["cursor"] ?? 0]
            if let epoch = value["epoch"] { request["epoch"] = epoch }
            if let merged = try? await call("LedgerMerge", request), let next = merged["text"] as? String, merged["changed"] as? Bool == true {
                text = next
                persist()
                didChange = true
            }
        }
        if let prefs = value["prefs"] as? [String: Any], let weighted = prefs["weighted"] as? Bool, let at = prefs["at"] as? Double {
            defaults.set(weighted, forKey: Self.weightedKey)
            defaults.set(at, forKey: Self.weightedAtKey)
            didChange = true
        }
        if didChange { revision += 1 }
    }

    /// 送れた行の印だけを消す（読み取りのあとにさらに変わった行は、次の同期でもう一度送る）。
    func syncPushed() async {
        await serialized { [self] in
            for id in inFlight where !touched.contains(id) { dirty.remove(id) }
            inFlight = []
            touched = []
            pushedOnce = true
        }
    }

    func resetSync() {
        enqueue { [self] in
            if var obj = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] {
                obj["syncCursor"] = 0
                text = Self.json(obj)
                persist()
            }
            dirty.removeAll()
            inFlight.removeAll()
            touched.removeAll()
            pushedOnce = false
        }
    }

    // MARK: JS呼び出し

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

    private func call(_ function: String, _ arguments: [String: Any]) async throws -> [String: Any] {
        try Self.object(try await core.callAsync(function, Self.json(arguments)))
    }
}
