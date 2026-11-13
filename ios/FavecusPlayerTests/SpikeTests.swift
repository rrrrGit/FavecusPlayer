import JavaScriptCore
import Security
import XCTest

/// Step11の事前確認（スパイク）：①JavaScriptCoreでのasync/awaitとSwift側の遅れて解決するPromise、②署名なしのシミュレーターでのKeychain、③ATSとhttp://127.0.0.1。
/// 結果は SPIKE_… の行に出力する。確認が済んだら、実際のテストへ置き換える。
final class SpikeTests: XCTestCase {
    func testAsyncAwaitWithAPromiseResolvedLaterFromSwift() throws {
        let context = try XCTUnwrap(JSContext())
        let queue = DispatchQueue(label: "spike.queue")
        var errors: [String] = []
        context.exceptionHandler = { _, exception in errors.append(exception?.toString() ?? "?") }
        let host: @convention(block) (String) -> JSValue = { argument in
            JSValue(newPromiseIn: context) { resolve, _ in
                DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) {
                    queue.async { _ = resolve?.call(withArguments: ["r-\(argument)"]) }
                }
            }
        }
        context.setObject(host, forKeyedSubscript: "hostFetch" as NSString)
        context.evaluateScript("globalThis.run = async function (n) { const a = await hostFetch('x'); const b = await hostFetch('y' + n); return a + '|' + b; }")
        let done = expectation(description: "resolved")
        var output = ""
        let callback: @convention(block) (JSValue) -> Void = { value in output = value.toString(); done.fulfill() }
        queue.sync {
            let promise = context.objectForKeyedSubscript("run").call(withArguments: [7])
            promise?.invokeMethod("then", withArguments: [callback])
        }
        wait(for: [done], timeout: 5)
        print("SPIKE_JS_ASYNC output=\(output) errors=\(errors)")
        XCTAssertEqual(output, "r-x|r-y7")
    }

    func testKeychainInTheUnsignedSimulatorTestHost() {
        let account = "spike-\(UUID().uuidString)"
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "dev.favecus.player.spike", kSecAttrAccount as String: account]
        var add = base
        add[kSecValueData as String] = Data("secret".utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let added = SecItemAdd(add as CFDictionary, nil)
        var read = base
        read[kSecReturnData as String] = true
        var result: CFTypeRef?
        let fetched = SecItemCopyMatching(read as CFDictionary, &result)
        let deleted = SecItemDelete(base as CFDictionary)
        print("SPIKE_KEYCHAIN add=\(added) read=\(fetched) delete=\(deleted) value=\((result as? Data).map { String(decoding: $0, as: UTF8.self) } ?? "nil")")
        XCTAssertEqual(added, errSecSuccess)
        XCTAssertEqual(fetched, errSecSuccess)
    }

    func testPlainHttpToLocalhostIsAllowed() async throws {
        let raw = try XCTUnwrap(ProcessInfo.processInfo.environment["FAVECUS_SPIKE_URL"], "FAVECUS_SPIKE_URL が渡されていません")
        var request = URLRequest(url: try XCTUnwrap(URL(string: raw)))
        request.timeoutInterval = 10
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            print("SPIKE_ATS status=\((response as? HTTPURLResponse)?.statusCode ?? -1) body=\(String(decoding: data, as: UTF8.self))")
        } catch {
            print("SPIKE_ATS error=\(error)")
            XCTFail("\(error)")
        }
    }
}
