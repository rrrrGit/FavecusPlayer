import AVFoundation
import UIKit
import XCTest
@testable import FavecusPlayer

final class NativeConcurrencyTests: XCTestCase {
    private final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        func increment() { lock.withLock { count += 1 } }
        var value: Int { lock.withLock { count } }
    }

    func testSoundCompletionBeforeContinuationBindingResumesAndMarksOnlyOnce() async {
        let marks = Counter()
        let state = AlarmSoundMaker.CompletionState { marks.increment() }
        state.cancel()
        state.complete()
        await withCheckedContinuation { state.bind($0) }
        state.complete()
        XCTAssertTrue(state.isCancelled)
        XCTAssertTrue(state.isFinished)
        XCTAssertEqual(marks.value, 1)
    }

    func testConcurrentSoundCancellationAndCompletionResumeAWaitingTaskOnce() async {
        let marks = Counter()
        let state = AlarmSoundMaker.CompletionState { marks.increment() }
        let bound = expectation(description: "continuation bound")
        let resumed = expectation(description: "continuation resumed without a media callback")
        let waiter = Task {
            await withCheckedContinuation { continuation in
                state.bind(continuation)
                bound.fulfill()
            }
            resumed.fulfill()
        }
        await fulfillment(of: [bound], timeout: 2)
        DispatchQueue.concurrentPerform(iterations: 100) { index in
            if index.isMultiple(of: 2) { state.cancel() }
            state.complete()
        }
        await fulfillment(of: [resumed], timeout: 2)
        waiter.cancel()
        XCTAssertTrue(state.isCancelled)
        XCTAssertEqual(marks.value, 1)
    }

    @MainActor
    func testBackgroundExpirationCancelsWorkersBeforeAndAfterBinding() async {
        let early = BackgroundRefreshCancellation()
        early.cancel()
        let earlyWorker = Task { @MainActor in !Task.isCancelled }
        early.bind(earlyWorker)
        let earlyResult = await earlyWorker.value
        XCTAssertFalse(earlyResult)

        let late = BackgroundRefreshCancellation()
        let lateWorker = Task { @MainActor in !Task.isCancelled }
        late.bind(lateWorker)
        late.cancel()
        late.cancel()
        let lateResult = await lateWorker.value
        XCTAssertFalse(lateResult)
        early.finish()
        late.finish()
    }
}

@MainActor
final class ViewLifecycleTests: XCTestCase {
    private final class Delegate: NSObject, UIGestureRecognizerDelegate {}

    func testVideoUpdatesDuringBackgroundKeepTheLayerDetachedUntilForeground() {
        let view = VideoSurface.LayerView()
        let first = AVPlayer(), next = AVPlayer()
        view.isInBackground = false
        view.observeApplicationState()
        view.updatePlayer(first)
        XCTAssertTrue(view.playerLayer.player === first)
        NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
        XCTAssertTrue(view.isInBackground)
        XCTAssertNil(view.playerLayer.player)
        view.updatePlayer(next)
        XCTAssertNil(view.playerLayer.player)
        NotificationCenter.default.post(name: UIApplication.willEnterForegroundNotification, object: nil)
        XCTAssertFalse(view.isInBackground)
        XCTAssertTrue(view.playerLayer.player === next)
        view.updatePlayer(nil)
        XCTAssertNil(view.playerLayer.player)
    }

    func testSwipeBackRestoresTheOriginalDelegateButPreservesANewerOwner() throws {
        let holder = SwipeBackEnabler.Holder()
        let navigation = UINavigationController(rootViewController: holder)
        navigation.loadViewIfNeeded()
        let gesture = try XCTUnwrap(navigation.interactivePopGestureRecognizer)
        let original = Delegate(), newer = Delegate()
        gesture.delegate = original
        holder.viewDidAppear(false)
        holder.viewDidAppear(false) // 再度表示されても元のdelegateを上書きしない
        XCTAssertTrue(gesture.delegate === holder.popDelegate)
        holder.viewWillDisappear(false)
        XCTAssertTrue(gesture.delegate === original)
        holder.viewDidAppear(false)
        gesture.delegate = newer
        holder.viewWillDisappear(false)
        XCTAssertTrue(gesture.delegate === newer)
    }
}

final class JavaScriptHostLifetimeTests: XCTestCase {
    private final class Host: SyncHost, RequestHost, @unchecked Sendable {
        func library() async -> String { "{}" }
        func write(_ json: String) async throws {}
        func persist(_ text: String) async throws {}
        func backup() async throws -> String { "" }
        func recovered() async -> Bool { false }
        func request(method: String, url: String, json: String) async throws -> String { "{}" }
        func saveSession(_ json: String) {}
    }

    func testSyncAndBilibiliContextsReleaseTheirCapturedHosts() throws {
        weak var syncHost: Host?
        weak var biliHost: Host?
        try autoreleasepool {
            let first = Host(), second = Host()
            syncHost = first
            biliHost = second
            _ = try SyncCore(source: "", host: first)
            _ = try BiliCore(source: "", host: second)
        }
        XCTAssertNil(syncHost, "JSContextとhostブロックの循環参照を残さない")
        XCTAssertNil(biliHost)
    }
}
