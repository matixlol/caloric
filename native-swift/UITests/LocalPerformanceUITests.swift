import XCTest

/// Opt-in checks against a local backend with a real account's data.
/// `TEST_RUNNER_CALORIC_PERF_LOGIN` points to a JSON file with `email` and `password`;
/// the app must be built with `CALORIC_BACKEND_URL` set to that local backend.
final class LocalPerformanceUITests: XCTestCase {
    private struct Login: Decodable { var email: String; var password: String }

    private func login() throws -> Login {
        guard let path = ProcessInfo.processInfo.environment["CALORIC_PERF_LOGIN"] else { throw XCTSkip("Local performance account required.") }
        return try JSONDecoder().decode(Login.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
    }

    private func signedIn() throws -> XCUIApplication {
        let login = try login()
        let app = XCUIApplication()
        app.launchArguments = ["-perf-hitches"]
        app.launch()
        let email = app.textFields["login-email"]
        let today = app.staticTexts["Today"].firstMatch
        if email.waitForExistence(timeout: 4), !today.exists {
            app.segmentedControls.buttons["Password"].tap()
            email.tap(); email.typeText(login.email)
            let password = app.secureTextFields["login-password"]
            password.tap(); password.typeText(login.password)
            app.buttons["Sign in"].tap()
        }
        XCTAssertTrue(today.waitForExistence(timeout: 30))
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let notNow = springboard.buttons.matching(NSPredicate(format: "label IN %@", ["Not Now", "Ahora no", "Allow", "Permitir"])).firstMatch
        if notNow.waitForExistence(timeout: 2) { notNow.tap() }
        return app
    }

    func testSignInWithLocalAccount() throws {
        _ = try signedIn()
    }

    /// Cold launch until the diary is on screen (not a spinner).
    func testColdLaunchShowsDiary() throws {
        let app = try signedIn()
        let options = XCTMeasureOptions()
        options.iterationCount = 5
        options.invocationOptions = [.manuallyStart, .manuallyStop]
        measure(metrics: [XCTClockMetric()], options: options) {
            app.terminate()
            startMeasuring()
            app.launch()
            XCTAssertTrue(app.staticTexts["Today"].firstMatch.waitForExistence(timeout: 30))
            stopMeasuring()
        }
    }

    /// Hold the microphone, lock, then discard; repeated so a profiler can attach.
    func testVoiceStartRepeatedly() throws {
        let app = try signedIn()
        let microphone = app.buttons["voice-microphone"]
        XCTAssertTrue(microphone.waitForExistence(timeout: 5))
        let rounds = Int(ProcessInfo.processInfo.environment["CALORIC_PERF_VOICE_ROUNDS"] ?? "") ?? 4
        for _ in 0..<rounds {
            let start = microphone.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            start.press(forDuration: 1.2, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -90)))
            let cancel = app.buttons["Cancel voice recording"]
            if cancel.waitForExistence(timeout: 2) { cancel.tap() } // recording cannot start without simulator audio input
            XCTAssertTrue(microphone.waitForExistence(timeout: 5))
            sleep(1)
        }
    }

    /// Debug builds only: synthetic audio (`-ui-test-voice`) with a long diary; hitches are logged with `-perf-hitches`.
    func testSyntheticVoiceStartHitches() throws {
        guard ProcessInfo.processInfo.environment["CALORIC_PERF_VOICE"] != nil else { throw XCTSkip("Opt-in benchmark (TEST_RUNNER_CALORIC_PERF_VOICE=1).") }
        let app = XCUIApplication()
        app.launchArguments = ["-ui-testing", "-seed-food", "-seed-long-diary", "-ui-test-voice", "-ui-test-voice-slow-start", "-perf-hitches"]
        app.launch()
        let microphone = app.buttons["voice-microphone"]
        XCTAssertTrue(microphone.waitForExistence(timeout: 10))
        sleep(2)
        for _ in 0..<5 {
            let start = microphone.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            start.press(forDuration: 2.0, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -90)))
            XCTAssertTrue(app.buttons["Cancel voice recording"].waitForExistence(timeout: 5))
            app.buttons["Cancel voice recording"].tap()
            XCTAssertTrue(microphone.waitForExistence(timeout: 5))
            sleep(1)
        }
    }
}
