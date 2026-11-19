import Foundation

/// 前回の続きから再生（v0.7.3 F2）。最後に再生していた曲・再生範囲・位置を、この端末にだけ保存する（同期しない）。
/// 規則は、PC版（src/core/resume-point.cjs）と同じ：約10秒ごと（一時停止にした瞬間は、すぐ）に保存し、
/// 再開の位置は、5秒未満・終わりの5秒以内なら、曲の頭から。読めない・形式が違う保存は、使わない。
struct ResumeRecord: Codable, Equatable {
    var entryId: String
    var playlistId: String
    var scope: String
    var position: Double
    var duration: Double
    var savedAt: Double = 0
}

@MainActor
final class ResumeStore {
    static let edgeSeconds: Double = 5
    static let interval: TimeInterval = 10

    /// 再開の位置（秒）。
    nonisolated static func resumePosition(position: Double, duration: Double) -> Double {
        guard position.isFinite, position >= edgeSeconds else { return 0 }
        if duration.isFinite, duration > 0, position > duration - edgeSeconds { return 0 }
        return position.rounded(.down)
    }

    private let defaults: UserDefaults
    private let key = "playbackResume"
    private let now: () -> Date
    private var pending: ResumeRecord?
    private var lastWrite = Date.distantPast
    private var lastPaused = true

    init(defaults: UserDefaults = .standard, now: @escaping () -> Date = { Date() }) {
        self.defaults = defaults
        self.now = now
    }

    private func valid(_ record: ResumeRecord) -> Bool {
        func text(_ value: String) -> Bool { !value.isEmpty && value.count <= 200 }
        return text(record.entryId) && text(record.playlistId) && text(record.scope)
            && record.position.isFinite && record.position >= 0 && record.duration.isFinite && record.duration >= 0
    }

    /// 保存した内容（書き込み前の最新を含む）。位置は、規則で補正して返す。
    func get() -> ResumeRecord? {
        var record = pending
        if record == nil, let data = defaults.data(forKey: key), let saved = try? JSONDecoder().decode(ResumeRecord.self, from: data), valid(saved) { record = saved }
        guard var found = record else { return nil }
        found.position = Self.resumePosition(position: found.position, duration: found.duration)
        return found
    }

    func observe(_ sample: ResumeRecord, paused: Bool) {
        var record = sample
        record.position = record.position.rounded(.down)
        record.savedAt = now().timeIntervalSince1970
        guard valid(record) else { return }
        pending = record
        let becamePaused = paused && !lastPaused
        lastPaused = paused
        if becamePaused || now().timeIntervalSince(lastWrite) >= Self.interval { flush() }
    }

    func flush() {
        guard let record = pending else { return }
        pending = nil
        lastWrite = now()
        if let data = try? JSONEncoder().encode(record) { defaults.set(data, forKey: key) }
    }

    func clear() {
        pending = nil
        defaults.removeObject(forKey: key)
    }
}
