import Foundation

/// お気に入り（v0.7.4〜）。お気に入りの曲は、シャッフル再生で、少しだけ選ばれやすくする（重みの倍率は、共通JS：src/core/play-ledger.cjs の FAVORITE_BOOST）。
/// 規則は、共通JS（src/core/favorites-core.cjs）・PC版（src/core/favorites.cjs）と同じ。
/// ローカル曲（local:...）はこの端末内のみ、Bilibili曲（bili:... / bili-av:...）は同期する（v0.7.5）。
/// 保存は Application Support/FavecusPlayer/favorites.json（原子的に書く）。以前の版の UserDefaults の保存は、初回だけ、ここへ移す。
/// 正しくないキー・壊れた保存は、使わない（壊れたファイルは、別名で残してから、空で始める）。
@MainActor
final class FavoritesStore: ObservableObject {
    static let maxKeys = 20000
    static let maxTombstones = 20000
    static let maxFutureSkewMs: Int64 = 600_000
    static let currentVersion = 1

    struct StateEntry: Codable, Equatable {
        var fav: Bool
        var at: Int64
    }

    private struct Document: Codable {
        var version: Int
        var keys: [String]
        var states: [String: StateEntry]?
        var syncCursor: Int?
    }

    @Published private(set) var keys: Set<String> = []
    @Published private(set) var revision = 0
    private let core: SharedCore?
    private let defaults: UserDefaults
    private let legacyKey = "favoriteKeys"
    private let fileURL: URL
    private var states: [String: StateEntry] = [:]
    private var syncCursor = 0
    private var dirty: Set<String> = []
    private var inFlight: Set<String> = []
    private var touched: Set<String> = []
    private var pushedOnce = false
    private var migrated = false
    private var merging = false
    private var touchedWhileMerging: Set<String> = []
    private var reading = false
    private var touchedDuringRead: Set<String> = []
    private var tail: Task<Void, Never> = Task {}
    var onChange: (() -> Void)?
    /// 直近の保存の失敗（なければ nil）。保存できなくても、メモリ上の状態では動く。
    private(set) var saveError: String?

    init(defaults: UserDefaults = .standard, directory: URL? = nil, core: SharedCore? = nil) {
        self.core = core
        self.defaults = defaults
        let folder = directory ?? Self.defaultDirectory()
        fileURL = folder.appendingPathComponent("favorites.json")
        load()
    }

    static func defaultDirectory() -> URL {
        AtomicJsonFile.defaultDirectory()
    }

    nonisolated static func isValid(_ key: String) -> Bool {
        key.range(of: "^[A-Za-z0-9:._-]{1,200}$", options: .regularExpression) != nil
    }

    nonisolated static func isSyncKey(_ key: String) -> Bool {
        key.range(of: "^(?:bili:BV[A-Za-z0-9]{10}:p[1-9][0-9]{0,5}|bili-av:[1-9][0-9]{0,17}:p[1-9][0-9]{0,5})$", options: .regularExpression) != nil
    }

    private func deriveKeys() {
        keys = Set(states.compactMap { $0.value.fav ? $0.key : nil })
    }

    private func pruneTombstones() {
        let protected = dirty.union(inFlight).union(touched)
        let tombstones = states.filter { !$0.value.fav }
        guard tombstones.count > Self.maxTombstones else { return }
        var excess = tombstones.count - Self.maxTombstones
        let sorted = tombstones.sorted { $0.value.at != $1.value.at ? $0.value.at < $1.value.at : $0.key < $1.key }
        for (key, _) in sorted {
            if excess <= 0 { break }
            if protected.contains(key) { continue }
            states.removeValue(forKey: key)
            excess -= 1
        }
    }

    private func applyDocument(_ document: Document) {
        var nextStates: [String: StateEntry] = [:]
        var favCount = 0
        if let rawStates = document.states {
            for (key, entry) in rawStates where Self.isValid(key) && entry.at >= 1 {
                if entry.fav {
                    guard favCount < Self.maxKeys else { continue }
                    favCount += 1
                }
                nextStates[key] = entry
            }
            migrated = false
        } else {
            for key in document.keys where Self.isValid(key) && nextStates[key] == nil {
                guard favCount < Self.maxKeys else { break }
                favCount += 1
                nextStates[key] = StateEntry(fav: true, at: 1)
            }
            migrated = !nextStates.isEmpty
        }
        states = nextStates
        syncCursor = max(0, document.syncCursor ?? 0)
        pruneTombstones()
        deriveKeys()
    }

    private func load() {
        if FileManager.default.fileExists(atPath: fileURL.path) {
            do {
                if let core, let raw = (try? Data(contentsOf: fileURL)).flatMap({ String(data: $0, encoding: .utf8) }),
                   let result = try? Self.object(core.call("FavoritesOpen", Self.json(["text": raw]))),
                   let normalized = result["text"] as? String {
                    let document = try JSONDecoder().decode(Document.self, from: Data(normalized.utf8))
                    applyDocument(document)
                    migrated = result["migrated"] as? Bool ?? migrated
                    return
                }
                let document = try AtomicJsonFile.read(Document.self, from: fileURL)
                guard document.version == Self.currentVersion else { throw SharedCoreError.invalidResult("version") }
                applyDocument(document)
            } catch {
                // 壊れた保存は、消さずに別名で残す
                try? FileManager.default.moveItem(at: fileURL, to: fileURL.deletingLastPathComponent().appendingPathComponent("favorites.broken-\(Int(Date().timeIntervalSince1970)).json"))
            }
            return
        }
        // 以前の版（UserDefaults）からの移行：書き込めたことを確かめてから、古い保存を消す
        if let list = defaults.array(forKey: legacyKey) as? [String] {
            for key in list where Self.isValid(key) && states[key] == nil && states.count < Self.maxKeys {
                states[key] = StateEntry(fav: true, at: 1)
            }
            migrated = !states.isEmpty
            deriveKeys()
            if save() { defaults.removeObject(forKey: legacyKey) }
        }
    }

    private func currentDocument() -> Document {
        Document(version: Self.currentVersion, keys: keys.sorted(), states: states, syncCursor: syncCursor)
    }

    private func serializedDocument() -> String {
        guard let data = try? JSONEncoder().encode(currentDocument()), let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text
    }

    @discardableResult
    private func save() -> Bool {
        do {
            try AtomicJsonFile.write(currentDocument(), to: fileURL)
            saveError = nil
            return true
        } catch {
            saveError = error.localizedDescription
            return false
        }
    }

    func contains(_ key: String?) -> Bool {
        guard let key else { return false }
        return keys.contains(key)
    }

    /// お気に入りにする／外す。キーが正しくない・上限を超える場合は、何も変えず false。
    @discardableResult
    func set(_ key: String?, _ value: Bool) -> Bool {
        guard let key, Self.isValid(key) else { return false }
        let prev = states[key]
        let prevFav = prev?.fav ?? false
        if value && !prevFav && keys.count >= Self.maxKeys { return false }
        if prevFav == value { return true }
        let nowMs = Self.nowMsInt()
        let at = max(nowMs, (prev?.at ?? 0) + 1)
        states[key] = StateEntry(fav: value, at: at)
        deriveKeys()
        pruneTombstones()
        save()
        revision += 1
        if merging { touchedWhileMerging.insert(key) }
        if Self.isSyncKey(key) {
            dirty.insert(key)
            if inFlight.contains(key) { touched.insert(key) }
            if reading { touchedDuringRead.insert(key) }
            onChange?()
        }
        return true
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

    // MARK: 同期（sync-counts.cjs の favorites アダプター。JSの host から呼ばれる）

    func syncRead(deviceId: String) async -> String? {
        await serialized { [self] () async -> String? in
            let docText = serializedDocument()
            let filterKeys: Any = pushedOnce ? Array(dirty) : NSNull()
            var cursor = syncCursor
            var rows: [[String: Any]] = []
            reading = true
            touchedDuringRead = []
            defer { reading = false; touchedDuringRead = [] }
            if let core, let result = try? Self.object(try await core.callAsync("FavoritesSyncState", Self.json(["text": docText, "keys": filterKeys]))) {
                cursor = result["cursor"] as? Int ?? syncCursor
                rows = result["rows"] as? [[String: Any]] ?? []
            } else {
                let filter = pushedOnce ? dirty : nil
                rows = states.filter { Self.isSyncKey($0.key) && (filter == nil || filter!.contains($0.key)) }
                    .sorted { $0.key < $1.key }
                    .map { ["key": $0.key, "fav": $0.value.fav, "at": $0.value.at] as [String: Any] }
            }
            inFlight = Set(rows.compactMap { $0["key"] as? String })
            touched = touchedDuringRead
            return Self.json(["deviceId": deviceId, "cursor": cursor, "rows": rows])
        }
    }

    func syncApply(_ json: String) async {
        guard let value = try? Self.object(json) else { return }
        await serialized { [self] in
            await applySerialized(value)
        }
    }

    private func applySerialized(_ value: [String: Any]) async {
        let protected = Array(dirty.union(inFlight).union(touched))
        let rows = value["rows"] as? [[String: Any]] ?? []
        let cursor = value["cursor"] as? Int ?? 0
        var changed = false
        var mergedCount = 0

        if let core {
            let docText = serializedDocument()
            merging = true
            touchedWhileMerging = []
            defer { merging = false; touchedWhileMerging = [] }
            let request: [String: Any] = ["text": docText, "rows": rows, "cursor": cursor, "now": Self.nowMsInt(), "protectedKeys": protected]
            if let result = try? Self.object(try await core.callAsync("FavoritesMerge", Self.json(request))),
               let nextText = result["text"] as? String,
               let decoded = try? JSONDecoder().decode(Document.self, from: Data(nextText.utf8)),
               let nextStates = decoded.states {
                let preserved = touchedWhileMerging.reduce(into: [String: StateEntry]()) { map, k in map[k] = states[k] }
                states = nextStates
                var favCount = states.values.filter(\.fav).count
                for key in preserved.keys.sorted() {
                    guard let current = preserved[key] else { continue }
                    let wasFav = states[key]?.fav ?? false
                    if current.fav && !wasFav {
                        guard favCount < Self.maxKeys else { continue }
                        favCount += 1
                    } else if !current.fav && wasFav {
                        favCount = max(0, favCount - 1)
                    }
                    states[key] = current
                }
                syncCursor = max(syncCursor, decoded.syncCursor ?? cursor)
                mergedCount = result["mergedCount"] as? Int ?? 0
                changed = (result["changed"] as? Bool ?? false) || mergedCount > 0
            }
        } else {
            let maxAt = Self.nowMsInt() + Self.maxFutureSkewMs
            var favCount = keys.count
            for row in rows {
                guard let key = row["key"] as? String, Self.isSyncKey(key), let fav = row["fav"] as? Bool, let rawAt = (row["at"] as? NSNumber)?.int64Value, rawAt >= 1 else { continue }
                let at = min(rawAt, maxAt)
                guard at >= 1 else { continue }
                let local = states[key]
                let newer = local == nil || at > local!.at || (at == local!.at && fav && !local!.fav)
                guard newer else { continue }
                if fav && !(local?.fav ?? false) {
                    guard favCount < Self.maxKeys else { continue }
                    favCount += 1
                } else if !fav && (local?.fav ?? false) {
                    favCount = max(0, favCount - 1)
                }
                states[key] = StateEntry(fav: fav, at: at)
                mergedCount += 1
            }
            if cursor > syncCursor { syncCursor = cursor; changed = true }
            if mergedCount > 0 { changed = true }
        }

        if changed || migrated {
            pruneTombstones()
            deriveKeys()
            if save() { migrated = false }
            if mergedCount > 0 { revision += 1 }
        }
    }

    func syncPushed() {
        for key in inFlight where !touched.contains(key) { dirty.remove(key) }
        inFlight = []
        touched = []
        pushedOnce = true
        if migrated && save() { migrated = false }
    }

    func resetSync() {
        enqueue { [self] in
            syncCursor = 0
            pushedOnce = false
            dirty = []
            inFlight = []
            touched = []
            save()
        }
    }

    // MARK: JSON / 時刻

    private static func nowMsInt() -> Int64 { Int64(max(1, (Date().timeIntervalSince1970 * 1000).rounded())) }

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
