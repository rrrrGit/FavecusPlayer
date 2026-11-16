import AVFoundation
import SwiftUI

/// 画面確認用（シミュレーターのスクリーンショット）。起動引数 -FavecusDemoAlarm list/edit/picker/range で、
/// 模擬のアラームと曲を使った画面を出す。予約は行わず、保存先も一時フォルダ。通常の起動では使われない。
enum AlarmDemoMode: String, Identifiable {
    case list, edit, picker, range
    var id: String { rawValue }
}

private struct DemoScheduler: AlarmScheduling {
    func requestAuthorization() async -> AlarmAuthorization { .authorized }
    func schedule(_ item: AlarmItem, soundName: String?) async throws {}
    func cancel(id: UUID) async {}
    func scheduledIDs() async -> Set<UUID>? { nil }
}

struct AlarmDemoView: View {
    let mode: AlarmDemoMode
    let store: LibraryStore
    let downloads: DownloadService?
    @StateObject private var service: AlarmService
    @State private var demoFile: URL?

    init(mode: AlarmDemoMode, store: LibraryStore, downloads: DownloadService?) {
        self.mode = mode
        self.store = store
        self.downloads = downloads
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("favecus-alarm-demo-\(UUID().uuidString)")
        _service = StateObject(wrappedValue: AlarmService(store: AlarmStore(directory: directory), scheduler: DemoScheduler()))
    }

    var body: some View {
        let catalog = AlarmSongCatalog(store: store, downloads: downloads)
        NavigationStack {
            switch mode {
            case .list, .edit:
                AlarmListView(service: service, catalog: catalog, startEditing: mode == .edit)
            case .picker:
                AlarmSoundPicker(catalog: catalog, current: nil) { _ in }
            case .range:
                if let demoFile {
                    AlarmRangeEditor(song: AlarmSong(key: "demo", title: "朝のピアノ", file: demoFile), initial: AlarmSound(mediaKey: "demo", startSeconds: 62, durationSeconds: 15)) { _ in }
                } else {
                    Color.clear
                }
            }
        }
        .task {
            await service.save(AlarmItem(hour: 6, minute: 30, weekdays: [2, 3, 4, 5, 6], label: "起きる", sound: AlarmSound(mediaKey: "demo", startSeconds: 62, durationSeconds: 15)))
            await service.save(AlarmItem(hour: 8, minute: 15, weekdays: [1, 7], label: ""))
            await service.save(AlarmItem(hour: 22, minute: 0, weekdays: [], enabled: false, label: "薬"))
            if mode == .range { demoFile = Self.makeDemoAudio(seconds: 180) }
        }
    }

    /// 長さだけが分かればよい、模擬の音声（WAV・低いサンプルレート）。
    private static func makeDemoAudio(seconds: Double) -> URL? {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("favecus-demo-\(UUID().uuidString).wav")
        let rate = 8000.0
        guard let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: rate, channels: 1, interleaved: true),
              let file = try? AVAudioFile(forWriting: url, settings: format.settings),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(seconds * rate)) else { return nil }
        buffer.frameLength = buffer.frameCapacity
        do { try file.write(from: buffer) } catch { return nil }
        return url
    }
}
