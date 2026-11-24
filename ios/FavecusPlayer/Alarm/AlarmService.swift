import Foundation

/// アラームの追加・変更・削除と、予約の反映。予約→保存の順で行い、保存に失敗したら予約を戻す。
@MainActor
final class AlarmService: ObservableObject {
    @Published private(set) var alarms: [AlarmItem]
    @Published var notice: String?
    private let store: AlarmStore
    private let scheduler: AlarmScheduling
    /// 音の曲のファイルを探す（メディアキー→ファイル）と、作った音の置き場（Library/Sounds）。どちらかがなければ、既定の音。
    var soundSource: ((String) -> URL?)?
    var soundsDirectory: URL?
    /// 「ランダム」の抽選（保存済みの曲から1曲選び、最初の30秒の音にして返す）。曲がなければ nil。
    var randomPicker: (() -> AlarmSound?)?
    var now: () -> Date = { Date() }
    var isLibraryReady: () -> Bool = { true }
    /// 「曲を再生」で起動・処理中のアラームID（resync 中にランダム再抽選で書き換えないため）。
    var pendingPlayAlarmId: (() -> String?)?
    private var resyncing = false
    private var needsResync = false
    private var opChain: Task<Void, Never>?

    init(store: AlarmStore, scheduler: AlarmScheduling) {
        self.store = store
        self.scheduler = scheduler
        alarms = store.alarms
        if case .blocked(let message) = store.state { notice = message }
    }

    private func serialize(_ work: @escaping @MainActor () async -> Void) async {
        let previous = opChain
        let task = Task { @MainActor in
            await previous?.value
            await work()
        }
        opChain = task
        await task.value
    }

    /// 追加または更新（同じIDは置き換える）。有効なら予約し、無効なら予約を外す。
    func save(_ input: AlarmItem) async {
        await serialize { await self.performSave(input, rollRandom: true, clearNotice: true) }
    }

    private func performSave(_ input: AlarmItem, rollRandom: Bool, clearNotice: Bool = true) async {
        if clearNotice { notice = nil }
        var item = input
        item.sound = item.sound?.normalized()
        guard item.isValid else { notice = AlarmError.invalid.localizedDescription; return }
        if item.randomSound && rollRandom { roll(&item) }
        if item.enabled {
            do { try await scheduler.schedule(item, soundName: await prepareSound(item)) } catch {
                // 予約できなかったアラームは、無効のまま保存し、理由を知らせる
                item.enabled = false
                notice = error.localizedDescription
            }
        } else {
            await scheduler.cancel(id: item.id)
        }
        var next = alarms
        if let index = next.firstIndex(where: { $0.id == item.id }) { next[index] = item } else { next.append(item) }
        do {
            try store.save(next)
            alarms = next
            if item.sound == nil, let url = soundURL(id: item.id) { try? FileManager.default.removeItem(at: url) }
        } catch {
            await scheduler.cancel(id: item.id)
            notice = error.localizedDescription
        }
    }

    func setEnabled(id: UUID, _ enabled: Bool) async {
        await serialize {
            guard var item = self.alarms.first(where: { $0.id == id }) else { return }
            item.enabled = enabled
            await self.performSave(item, rollRandom: enabled)
        }
    }

    func remove(id: UUID) async {
        await serialize { await self.performRemove(id: id) }
    }

    private func performRemove(id: UUID) async {
        let next = alarms.filter { $0.id != id }
        do { try store.save(next); alarms = next } catch { notice = error.localizedDescription; return }
        await scheduler.cancel(id: id)
        if let url = soundURL(id: id) { try? FileManager.default.removeItem(at: url) }
    }

    // MARK: 音

    /// 「ランダム」を抽選し直す（保存済みの曲から1曲。最初の30秒）。次に鳴る時刻を覚え、その時刻を過ぎたあとの起動で、また抽選する。
    private func roll(_ item: inout AlarmItem) {
        item.sound = randomPicker?()
        item.rolledFor = item.nextFireDate(after: now())
        if item.sound == nil { notice = "ランダムに選べる保存済みの曲がないため、既定の音になります" }
    }

    static func soundFileName(id: UUID) -> String { "alarm-\(id.uuidString).caf" }

    private func soundURL(id: UUID) -> URL? { soundsDirectory?.appendingPathComponent(Self.soundFileName(id: id)) }

    /// 選んだ曲の範囲から、音のファイルを作り直す。作れなければ（曲の保存がない等）、知らせて既定の音にする。
    private func prepareSound(_ item: AlarmItem) async -> String? {
        guard let sound = item.sound, let target = soundURL(id: item.id) else { return nil }
        guard let source = soundSource?(sound.mediaKey) else {
            notice = "アラームの音の曲が、この端末に保存されていないため、既定の音になります"
            return nil
        }
        do {
            try await AlarmSoundMaker.make(source: source, start: sound.startSeconds, duration: sound.durationSeconds, output: target)
            return target.lastPathComponent
        } catch {
            notice = "アラームの音を作れなかったため、既定の音になります（\(error.localizedDescription)）"
            return nil
        }
    }

    private func soundFileIfReady(_ item: AlarmItem) -> String? {
        guard item.sound != nil, let url = soundURL(id: item.id), FileManager.default.fileExists(atPath: url.path) else { return nil }
        return url.lastPathComponent
    }

    /// 起動時：OS側の予約と、保存内容を合わせる。繰り返しのアラームで予約が消えていれば作り直す。
    /// 繰り返しなしで予約が残っていないものは、すでに鳴ったものとして無効にする（翌日に鳴り直さない）。
    func resync() async {
        if resyncing { needsResync = true; return }
        resyncing = true
        defer { resyncing = false }
        await serialize {
            repeat {
                self.needsResync = false
                await self.performResync()
            } while self.needsResync
        }
    }

    private func performResync() async {
        guard let live = await scheduler.scheduledIDs() else { return }
        let ready = isLibraryReady()
        for item in alarms where item.enabled && !live.contains(item.id) {
            if item.weekdays.isEmpty {
                var done = item
                done.enabled = false
                var next = alarms
                if let index = next.firstIndex(where: { $0.id == item.id }) { next[index] = done }
                try? store.save(next)
                alarms = next
            } else {
                var soundName = soundFileIfReady(item)
                if soundName == nil, item.sound != nil {
                    guard ready else { continue }
                    soundName = await prepareSound(item)
                }
                do { try await scheduler.schedule(item, soundName: soundName) } catch { notice = error.localizedDescription }
            }
        }
        guard ready else { return }
        // 「ランダム」：鳴る時刻を過ぎていたら、次の1回の曲を抽選し直す（「曲を再生」で開かれる途中の曲は、変えない）
        let pending = pendingPlayAlarmId?() ?? AlarmPlayRequest.peek()
        for item in alarms where item.enabled && item.randomSound && (item.rolledFor ?? .distantPast) <= now() && item.id.uuidString != pending {
            await performSave(item, rollRandom: true, clearNotice: false)
        }
    }
}
