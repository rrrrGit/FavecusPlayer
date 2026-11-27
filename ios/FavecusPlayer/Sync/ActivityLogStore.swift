import Foundation

/// アプリ稼働履歴の1件（時刻・種別・最小限のメタ情報。曲名・ファイルパス・認証情報は含めない）。
struct ActivityLogEntry: Codable, Equatable {
    var at: String
    var day: String
    var kind: String
    var detail: [String: String]?

    func jsonObject() -> [String: Any] {
        var obj: [String: Any] = ["at": at, "kind": kind]
        if let detail, !detail.isEmpty { obj["detail"] = detail }
        return obj
    }
}

/// 端末内の稼働履歴（Application Support/FavecusPlayer/activity-logs.json）。直近7日分のみ保持する。
@MainActor
final class ActivityLogStore {
    static let currentVersion = 1
    static let retentionDays = 7
    static let maxEntriesPerDay = 300

    private struct Document: Codable {
        var version: Int = currentVersion
        var lastSyncedAt: Double = 0
        var dirtyDays: [String] = []
        var entries: [ActivityLogEntry] = []
    }

    private let fileURL: URL
    private let calendar: Calendar
    var now: () -> Date
    private var document = Document()

    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    private static let timestampFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSSXXX"
        return f
    }()

    init(directory: URL, calendar: Calendar = .current, now: @escaping () -> Date = { Date() }) {
        self.fileURL = directory.appendingPathComponent("activity-logs.json")
        self.calendar = calendar
        self.now = now
        load()
    }

    var entries: [ActivityLogEntry] { document.entries }
    var lastSyncedAt: Double { document.lastSyncedAt }
    var dirtyDays: Set<String> { Set(document.dirtyDays) }

    func dayString(for date: Date) -> String {
        let f = Self.dayFormatter
        f.timeZone = calendar.timeZone
        return f.string(from: date)
    }

    func cutoffDayString(for date: Date) -> String {
        let start = calendar.startOfDay(for: date)
        let cutoff = calendar.date(byAdding: .day, value: -(Self.retentionDays - 1), to: start) ?? start
        return dayString(for: cutoff)
    }

    private func timestampString(for date: Date) -> String {
        let f = Self.timestampFormatter
        f.timeZone = calendar.timeZone
        return f.string(from: date)
    }

    /// イベントを1件記録し、7日より古い記録を整理して保存する。
    func record(_ kind: String, detail: [String: String] = [:], markDirty: Bool = true) {
        let current = now()
        let day = dayString(for: current)
        let entry = ActivityLogEntry(
            at: timestampString(for: current),
            day: day,
            kind: kind,
            detail: detail.isEmpty ? nil : detail
        )
        document.entries.append(entry)
        if markDirty, !document.dirtyDays.contains(day) { document.dirtyDays.append(day) }
        prune(for: current)
        save()
    }

    /// 今日の 0:00 以降にまだ同期していなければ true（前日分などの未同期がある場合も true）。
    func needsDailySync(at date: Date? = nil) -> Bool {
        let current = date ?? now()
        let todayStart = calendar.startOfDay(for: current).timeIntervalSince1970
        let todayString = dayString(for: current)
        return document.lastSyncedAt < todayStart || document.dirtyDays.contains { $0 < todayString }
    }

    /// 次の 0:00:00（ローカル時刻）を返す。
    func nextMidnight(after date: Date? = nil) -> Date {
        let current = date ?? now()
        let start = calendar.startOfDay(for: current)
        return calendar.date(byAdding: .day, value: 1, to: start) ?? start.addingTimeInterval(86400)
    }

    /// Supabase 送信用の日別ペイロードを返す（変更があった日、または今日の分）。
    func pendingSyncPayload(at date: Date? = nil) -> (days: [[String: Any]], retentionBeforeDay: String) {
        let current = date ?? now()
        prune(for: current)
        let cutoff = cutoffDayString(for: current)
        let targets = Set(document.dirtyDays)
        var grouped: [String: [[String: Any]]] = [:]
        for entry in document.entries where targets.contains(entry.day) {
            grouped[entry.day, default: []].append(entry.jsonObject())
        }
        let days: [[String: Any]] = grouped.keys.sorted().map { day in
            ["day": day, "entries": grouped[day] ?? []]
        }
        return (days, cutoff)
    }

    /// 同期成功時に呼ぶ。送信済みの日を dirty から外し、最終同期時刻を更新する。
    func markSynced(days: [String], at date: Date? = nil) {
        let current = date ?? now()
        let synced = Set(days)
        document.dirtyDays.removeAll { synced.contains($0) }
        document.lastSyncedAt = current.timeIntervalSince1970
        prune(for: current)
        save()
    }

    private func prune(for current: Date) {
        let cutoff = cutoffDayString(for: current)
        document.entries.removeAll { $0.day < cutoff }
        document.dirtyDays.removeAll { $0 < cutoff }
        // 1日あたりの上限件数を超えた場合は古いものから間引く
        var counts: [String: Int] = [:]
        var kept: [ActivityLogEntry] = []
        for entry in document.entries.reversed() {
            let count = counts[entry.day, default: 0]
            if count < Self.maxEntriesPerDay {
                counts[entry.day] = count + 1
                kept.append(entry)
            }
        }
        document.entries = kept.reversed()
    }

    private func load() {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return }
        do {
            let data = try Data(contentsOf: fileURL)
            let decoded = try JSONDecoder().decode(Document.self, from: data)
            guard decoded.version == Self.currentVersion else {
                backupBrokenFile()
                return
            }
            document = decoded
            prune(for: now())
        } catch {
            backupBrokenFile()
        }
    }

    private func backupBrokenFile() {
        let target = fileURL.deletingLastPathComponent().appendingPathComponent("activity-logs.broken-\(Int(now().timeIntervalSince1970))-\(UUID().uuidString.prefix(8)).json")
        try? FileManager.default.moveItem(at: fileURL, to: target)
        document = Document()
    }

    private func save() {
        do {
            try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(document)
            try data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            // ログ保存失敗でアプリ本体やアラーム処理を止めない
        }
    }
}
