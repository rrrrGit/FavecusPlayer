import Foundation

/// アラームの追加・変更・削除と、予約の反映。予約→保存の順で行い、保存に失敗したら予約を戻す。
@MainActor
final class AlarmService: ObservableObject {
    @Published private(set) var alarms: [AlarmItem]
    @Published var notice: String?
    private let store: AlarmStore
    private let scheduler: AlarmScheduling

    init(store: AlarmStore, scheduler: AlarmScheduling) {
        self.store = store
        self.scheduler = scheduler
        alarms = store.alarms
        if case .blocked(let message) = store.state { notice = message }
    }

    /// 追加または更新（同じIDは置き換える）。有効なら予約し、無効なら予約を外す。
    func save(_ input: AlarmItem) async {
        var item = input
        item.sound = item.sound?.normalized()
        guard item.isValid else { notice = AlarmError.invalid.localizedDescription; return }
        if item.enabled {
            do { try await scheduler.schedule(item) } catch {
                // 予約できなかったアラームは、無効のまま保存し、理由を知らせる
                item.enabled = false
                notice = error.localizedDescription
            }
        } else {
            await scheduler.cancel(id: item.id)
        }
        var next = alarms
        if let index = next.firstIndex(where: { $0.id == item.id }) { next[index] = item } else { next.append(item) }
        do { try store.save(next); alarms = next } catch {
            await scheduler.cancel(id: item.id)
            notice = error.localizedDescription
        }
    }

    func setEnabled(id: UUID, _ enabled: Bool) async {
        guard var item = alarms.first(where: { $0.id == id }) else { return }
        item.enabled = enabled
        await save(item)
    }

    func remove(id: UUID) async {
        let next = alarms.filter { $0.id != id }
        do { try store.save(next); alarms = next } catch { notice = error.localizedDescription; return }
        await scheduler.cancel(id: id)
    }

    /// 起動時：OS側の予約と、保存内容を合わせる。繰り返しのアラームで予約が消えていれば作り直す。
    /// 繰り返しなしで予約が残っていないものは、すでに鳴ったものとして無効にする（翌日に鳴り直さない）。
    func resync() async {
        guard let live = await scheduler.scheduledIDs() else { return }
        for item in alarms where item.enabled && !live.contains(item.id) {
            if item.weekdays.isEmpty {
                var done = item
                done.enabled = false
                var next = alarms
                if let index = next.firstIndex(where: { $0.id == item.id }) { next[index] = done }
                try? store.save(next)
                alarms = next
            } else {
                do { try await scheduler.schedule(item) } catch { notice = error.localizedDescription }
            }
        }
    }
}
