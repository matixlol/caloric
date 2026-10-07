import XCTest

final class CaloricSwiftUITests: XCTestCase {
    func testBetterAuthSignInScreenControls() {
        let app = XCUIApplication()
        app.launch()
        let email = app.textFields["login-email"]
        XCTAssertTrue(email.waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["Send code"].exists)
        XCTAssertFalse(app.buttons["Send code"].isEnabled)
        app.segmentedControls.buttons["Password"].tap()
        XCTAssertTrue(app.secureTextFields["login-password"].exists)
        XCTAssertFalse(app.buttons["Sign in"].isEnabled)
        app.buttons["New here? Create an account"].tap()
        XCTAssertTrue(app.textFields["login-name"].exists)
        XCTAssertTrue(app.buttons["Create account"].exists)
        app.segmentedControls.buttons["Email code"].tap()
        XCTAssertTrue(app.buttons["Send code"].exists)
        XCTAssertFalse(app.textFields["login-code"].exists)
        capture("Better Auth native sign-in", app)
    }

    private func launch(_ extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-ui-testing", "-seed-food"] + extra
        app.launch()
        XCTAssertTrue(app.staticTexts["Today"].firstMatch.waitForExistence(timeout: 10))
        return app
    }

    private func capture(_ name: String, _ app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testDiaryPortionEditingSearchAndCurrentNavigation() {
        let app = XCUIApplication()
        app.launchArguments = ["-ui-testing", "-seed-food"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Today"].firstMatch.waitForExistence(timeout: 10))
        app.buttons["Edit Grilled chicken"].tap()
        XCTAssertTrue(app.staticTexts["Portion"].waitForExistence(timeout: 3))
        app.buttons["Adjust portion +1/4"].tap()
        XCTAssertTrue(app.staticTexts["1 1/4 portions"].exists)
        app.buttons["Done"].tap()
        app.buttons["Add food to Breakfast"].tap()
        XCTAssertTrue(app.textFields["food-search"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Recents"].exists)
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Grilled chicken,")).firstMatch.tap()
        app.buttons["Add to Breakfast"].tap()
        XCTAssertTrue(app.textFields["ai-composer"].waitForExistence(timeout: 3))
        app.buttons["Settings"].tap()
        XCTAssertTrue(app.textFields["Daily calorie goal"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Macro Ratios"].exists)
    }

    func testPortionScrubbingUpdatesNutritionAndPreservesScrolling() {
        let app = launch()
        app.buttons["Edit Grilled chicken"].tap()
        let scrubber = app.descendants(matching: .any)["portion-scrubber"].firstMatch
        XCTAssertTrue(scrubber.waitForExistence(timeout: 3))
        let start = scrubber.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 80, dy: 0)))
        XCTAssertEqual(scrubber.value as? String, "2 portions")
        XCTAssertTrue(app.staticTexts["330 kcal"].exists)
        capture("Portion after horizontal drag", app)
        let vertical = scrubber.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        vertical.press(forDuration: 0.05, thenDragTo: vertical.withOffset(CGVector(dx: 0, dy: -60)))
        XCTAssertEqual(scrubber.value as? String, "2 portions")
        app.buttons["Done"].tap()
        app.buttons["Edit Grilled chicken"].tap()
        XCTAssertEqual(app.descendants(matching: .any)["portion-scrubber"].firstMatch.value as? String, "2 portions")
    }

    func testLongPressMovesFoodAcrossMealsAndReordersWithinMeal() {
        let app = launch(["-seed-drag-foods"])
        let scroll = app.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.7))
        scroll.press(forDuration: 0.05, thenDragTo: scroll.withOffset(CGVector(dx: 0, dy: -160)))
        let chicken = app.buttons["Edit Grilled chicken"]
        let destination = app.staticTexts["No dinner entries yet."]
        XCTAssertTrue(destination.waitForExistence(timeout: 3))
        chicken.press(forDuration: 0.55, thenDragTo: destination)
        let dinnerChicken = app.descendants(matching: .any)["diary-row-dinner-Grilled chicken"].firstMatch
        XCTAssertTrue(dinnerChicken.waitForExistence(timeout: 3), app.debugDescription)
        XCTAssertFalse(app.buttons["Close details"].exists, "Dropping a food must not open its details")
        let lunchRice = app.buttons["Edit Rice"]
        dinnerChicken.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.55, thenDragTo: lunchRice.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)))
        let lunchChicken = app.descendants(matching: .any)["diary-row-lunch-Grilled chicken"].firstMatch
        XCTAssertTrue(lunchChicken.waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["Close details"].exists)
        XCTAssertLessThan(lunchChicken.frame.minY, lunchRice.frame.minY)
        let riceStart = lunchRice.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let aboveChicken = lunchChicken.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
        riceStart.press(forDuration: 0.55, thenDragTo: aboveChicken)
        XCTAssertLessThan(lunchRice.frame.minY, lunchChicken.frame.minY)
        XCTAssertFalse(app.buttons["Close details"].exists)
        lunchRice.press(forDuration: 0.55)
        XCTAssertFalse(app.buttons["Close details"].exists, "Lifting without moving must not become a tap")
        capture("Diary after cross meal and same meal reordering", app)
        lunchRice.tap()
        XCTAssertTrue(app.buttons["Close details"].waitForExistence(timeout: 3), "Normal taps still open details after a drag")
        app.buttons["Done"].tap()
        let swipeStart = lunchRice.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5))
        swipeStart.press(forDuration: 0.05, thenDragTo: swipeStart.withOffset(CGVector(dx: -100, dy: 0)))
        let delete = app.buttons["Delete Rice"]
        XCTAssertTrue(delete.waitForExistence(timeout: 3), "Swipe deletion still works after reordering")
        capture("Revealed delete button", app)
        delete.tap()
        capture("After tapping delete", app)
        XCTAssertFalse(lunchRice.exists)
        XCTAssertTrue(lunchChicken.exists)
    }

    func testVoiceLockCancelWithoutInstructionalHints() {
        let app = launch(["-ui-test-voice"])
        XCTAssertTrue(app.textFields["ai-composer"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.staticTexts["Hold the mic to record · Release to send"].exists)
        let microphone = app.buttons["voice-microphone"]
        XCTAssertTrue(microphone.exists)
        let start = microphone.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        start.press(forDuration: 0.8, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -90)))
        XCTAssertTrue(app.buttons["Send voice message"].waitForExistence(timeout: 3), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Recording locked"].exists)
        XCTAssertFalse(app.staticTexts["Tap send when ready"].exists)
        capture("Locked recording with live waveform", app)
        app.buttons["Cancel voice recording"].tap()
        XCTAssertTrue(microphone.waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["Send voice message"].exists)
        let cancelStart = microphone.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        cancelStart.press(forDuration: 0.8, thenDragTo: cancelStart.withOffset(CGVector(dx: -110, dy: 0)))
        XCTAssertTrue(app.textFields["ai-composer"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.staticTexts["Recording"].exists)
        XCTAssertFalse(app.staticTexts["Voice message"].exists)
    }

    func testMacroDividerDragUsesStableCoordinates() {
        let app = launch()
        app.buttons["Settings"].tap()
        let handle = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Adjust protein and carbs split")).firstMatch
        XCTAssertTrue(handle.waitForExistence(timeout: 3))
        let oldValue = Int((handle.value as? String ?? "").components(separatedBy: " ")[0]) ?? 0
        let start = handle.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        start.press(forDuration: 0.1, thenDragTo: start.withOffset(CGVector(dx: 75, dy: 0)))
        let newValue = Int((handle.value as? String ?? "").components(separatedBy: " ")[0]) ?? 0
        XCTAssertGreaterThan(newValue, oldValue + 18)
        XCTAssertLessThan(newValue, oldValue + 28)
        capture("Macro ratios after divider drag", app)
    }

    func testFoodDragScrollsToAnOffscreenMeal() {
        let app = launch(["-seed-long-diary"])
        let chicken = app.buttons["Edit Grilled chicken"]
        let source = chicken.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let edge = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.88))
        source.press(forDuration: 0.55, thenDragTo: edge, withVelocity: .slow, thenHoldForDuration: 3)
        let moved = app.buttons["diary-row-snacks-Grilled chicken"]
        XCTAssertTrue(moved.waitForExistence(timeout: 3), app.debugDescription)
        XCTAssertFalse(app.buttons["Close details"].exists)
        capture("Food moved to initially offscreen Snacks", app)
    }

    private func replace(_ field: XCUIElement, with text: String) {
        field.tap()
        let current = field.value as? String ?? ""
        if !current.isEmpty && !current.contains("Search foods") && current != "g" { field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count)) }
        field.typeText(text)
    }

    func testQuickAddCreatesAndEditsCaloriesAndOptionalMacros() {
        let app = launch()
        app.buttons["Add food to Breakfast"].tap()
        app.buttons["Quick add"].tap()
        replace(app.textFields["Quick add calories"], with: "400")
        app.textFields["Quick add protein"].tap(); app.textFields["Quick add protein"].typeText("20")
        app.buttons["Add quick"].tap()
        XCTAssertTrue(app.buttons["Edit Quick add"].waitForExistence(timeout: 3))
        app.buttons["Edit Quick add"].tap()
        XCTAssertEqual(app.textFields["Quick add calories"].value as? String, "400")
        replace(app.textFields["Quick add calories"], with: "450")
        app.buttons["Done"].tap()
        app.buttons["Edit Quick add"].tap()
        XCTAssertEqual(app.textFields["Quick add calories"].value as? String, "450")
        XCTAssertFalse(app.staticTexts["Portion"].exists)
        capture("Quick add editing", app)
    }

    func testRecipesAddIngredientsDuplicateAndLogIndependentSnapshot() {
        let app = launch()
        app.buttons["Add food to Breakfast"].tap(); app.buttons["New recipe"].tap()
        let name = app.textFields["recipe-name"]
        XCTAssertTrue(name.waitForExistence(timeout: 3)); replace(name, with: "Chicken bowl")
        app.buttons["Add ingredient"].tap()
        XCTAssertTrue(app.buttons["Add to recipe"].waitForExistence(timeout: 3))
        let foods = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Grilled chicken,"))
        foods.element(boundBy: foods.count - 1).tap()
        app.buttons["Add to recipe"].tap()
        XCTAssertTrue(app.buttons["Edit ingredient Grilled chicken"].waitForExistence(timeout: 3))
        app.buttons["Duplicate recipe"].tap()
        XCTAssertEqual(name.value as? String, "Chicken bowl copy")
        app.buttons["Done"].tap()
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", "Chicken bowl copy", "ingredients")).firstMatch.tap()
        app.buttons["Add to Breakfast"].tap()
        XCTAssertTrue(app.buttons["Edit Chicken bowl copy"].waitForExistence(timeout: 3))
        app.buttons["Edit Chicken bowl copy"].tap()
        XCTAssertTrue(app.staticTexts["Ingredients"].exists)
        app.buttons["Edit ingredient Grilled chicken"].tap()
        app.buttons.matching(identifier: "Adjust portion +1/4").allElementsBoundByIndex.last!.tap()
        app.buttons["Done"].tap()
        app.buttons["Edit Chicken bowl copy"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "1 1/4 portions")).firstMatch.exists)
        capture("Logged recipe with editable ingredient snapshot", app)
    }

    func testHoldAndSlideQuickCaloriesAndAddPortion() {
        let app = launch()
        app.buttons["Add food to Breakfast"].tap()
        let quick = app.buttons["Quick add"]
        let start = quick.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        start.press(forDuration: 0.55, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -160)))
        XCTAssertTrue(app.buttons["Edit Quick add"].waitForExistence(timeout: 3))
        app.buttons["Edit Quick add"].tap()
        XCTAssertEqual(app.textFields["Quick add calories"].value as? String, "250")
        app.buttons["Done"].tap()
        app.buttons["Add food to Breakfast"].tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Grilled chicken,")).firstMatch.tap()
        let add = app.buttons["Add to Breakfast"]
        let portion = add.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        portion.press(forDuration: 0.55, thenDragTo: portion.withOffset(CGVector(dx: 0, dy: -145)))
        XCTAssertTrue(app.buttons["diary-row-breakfast-Grilled chicken"].waitForExistence(timeout: 3))
        app.buttons["diary-row-breakfast-Grilled chicken"].tap()
        XCTAssertEqual(app.descendants(matching: .any)["portion-scrubber"].firstMatch.value as? String, "1 portion")
        capture("Food added using hold and slide portion picker", app)
    }

    func testBarcodeManualEntryAndFriendsSettings() {
        let app = launch()
        app.buttons["Add food to Breakfast"].tap(); app.buttons["Scan barcode"].tap()
        let code = app.textFields["barcode-number"]
        XCTAssertTrue(code.waitForExistence(timeout: 3)); code.tap(); code.typeText("1234567")
        XCTAssertFalse(app.buttons["Look up barcode"].isEnabled)
        code.typeText("8"); app.buttons["Look up barcode"].tap()
        XCTAssertEqual(app.textFields["food-search"].value as? String, "12345678")
        app.buttons["Close food search"].tap(); app.buttons["Settings"].tap()
        app.swipeUp()
        XCTAssertTrue(app.staticTexts["Friends"].exists)
        XCTAssertTrue(app.buttons["Copy your friend code"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.textFields["Friend code"].exists)
        capture("Friends settings and account code", app)
    }
}
