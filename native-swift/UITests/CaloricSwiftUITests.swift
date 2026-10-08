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

    func testHomeScrollPerformance() {
        let app = launch(["-seed-long-diary"])
        let options = XCTMeasureOptions()
        options.iterationCount = 5
        measure(metrics: [XCTCPUMetric(application: app), XCTOSSignpostMetric.scrollingAndDecelerationMetric], options: options) {
            let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.72))
            let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25))
            start.press(forDuration: 0.01, thenDragTo: end, withVelocity: .fast, thenHoldForDuration: 0)
            end.press(forDuration: 0.01, thenDragTo: start, withVelocity: .fast, thenHoldForDuration: 0)
        }
    }

    func testDiaryPortionEditingSearchAndCurrentNavigation() {
        let app = XCUIApplication()
        app.launchArguments = ["-ui-testing", "-seed-food"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Today"].firstMatch.waitForExistence(timeout: 10))
        app.cells["Edit Grilled chicken"].tap()
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
        app.cells["Edit Grilled chicken"].tap()
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
        app.cells["Edit Grilled chicken"].tap()
        XCTAssertEqual(app.descendants(matching: .any)["portion-scrubber"].firstMatch.value as? String, "2 portions")
    }

    func testLongPressMovesFoodAcrossMealsAndReordersWithinMeal() {
        let app = launch(["-seed-drag-foods"])
        let scroll = app.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.7))
        scroll.press(forDuration: 0.05, thenDragTo: scroll.withOffset(CGVector(dx: 0, dy: -160)))
        let chicken = app.cells["Edit Grilled chicken"]
        let destination = app.staticTexts["No dinner entries yet."]
        XCTAssertTrue(destination.waitForExistence(timeout: 3))
        chicken.press(forDuration: 0.55, thenDragTo: destination)
        let dinnerChicken = app.descendants(matching: .any)["diary-row-dinner-Grilled chicken"].firstMatch
        XCTAssertTrue(dinnerChicken.waitForExistence(timeout: 3), app.debugDescription)
        XCTAssertFalse(app.buttons["Close details"].exists, "Dropping a food must not open its details")
        let lunchRice = app.cells["Edit Rice"]
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
        let delete = app.buttons["Delete"]
        XCTAssertTrue(delete.waitForExistence(timeout: 3), "Swipe deletion still works after reordering")
        capture("Revealed delete button", app)
        delete.tap()
        capture("After tapping delete", app)
        XCTAssertFalse(lunchRice.exists)
        XCTAssertTrue(lunchChicken.exists)
    }

    func testNativeFoodSwipeCanCloseDeleteAndFullSwipe() {
        let app = launch(["-seed-drag-foods"])
        let chicken = app.cells["diary-row-lunch-Grilled chicken"]
        XCTAssertTrue(chicken.waitForExistence(timeout: 3))
        let start = chicken.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: -100, dy: 0)))
        let delete = app.buttons["Delete"]
        XCTAssertTrue(delete.waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["Close details"].exists)
        capture("Native trailing delete action", app)
        let close = chicken.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.5))
        close.press(forDuration: 0.05, thenDragTo: close.withOffset(CGVector(dx: 110, dy: 0)))
        XCTAssertFalse(delete.exists)
        XCTAssertTrue(chicken.exists)
        chicken.tap()
        XCTAssertTrue(app.buttons["Close details"].waitForExistence(timeout: 3))
        app.buttons["Done"].tap()
        let second = chicken.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.5))
        second.press(forDuration: 0.05, thenDragTo: second.withOffset(CGVector(dx: -100, dy: 0)))
        XCTAssertTrue(delete.waitForExistence(timeout: 3))
        delete.tap()
        XCTAssertTrue(chicken.waitForNonExistence(timeout: 3))
        XCTAssertTrue(app.cells["diary-row-lunch-Rice"].exists)
        let rice = app.cells["diary-row-lunch-Rice"]
        let full = rice.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5))
        full.press(forDuration: 0.05, thenDragTo: full.withOffset(CGVector(dx: -rice.frame.width, dy: 0)))
        XCTAssertTrue(rice.waitForNonExistence(timeout: 3), "A full swipe uses the native destructive action")
        capture("Diary after native swipe deletions", app)
    }

    func testVoiceLockCancelWithoutInstructionalHints() {
        let app = launch(["-ui-test-voice", "-seed-long-diary"])
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

    func testQuickVoiceSlideLocksAndCancelsWhileAudioIsPreparing() {
        let app = launch(["-ui-test-voice", "-ui-test-voice-slow-start"])
        let microphone = app.buttons["voice-microphone"]
        let start = microphone.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -90)), withVelocity: .fast, thenHoldForDuration: 0)
        XCTAssertTrue(app.staticTexts["Recording locked"].waitForExistence(timeout: 3), "A quick upward slide must lock even before the audio route is ready")
        app.buttons["Cancel voice recording"].tap()
        XCTAssertTrue(microphone.waitForExistence(timeout: 3))
        let cancel = microphone.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        cancel.press(forDuration: 0.05, thenDragTo: cancel.withOffset(CGVector(dx: -110, dy: 0)), withVelocity: .fast, thenHoldForDuration: 0)
        XCTAssertTrue(app.textFields["ai-composer"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.staticTexts["Recording locked"].exists)
        XCTAssertFalse(app.buttons["Send voice message"].exists)
    }

    func testQuickAddTapOnlyOpensNumberFormAndSettingsHasNoUpdates() {
        let app = launch()
        app.buttons["Add food to Breakfast"].tap()
        let quick = app.buttons["Quick add"]
        quick.tap()
        XCTAssertTrue(app.textFields["Quick add calories"].waitForExistence(timeout: 3))
        XCTAssertEqual(quick.value as? String ?? "", "", "Tapping must not leave the hold-and-slide overlay open")
        capture("Quick add tap opens only the number form", app)
        app.buttons["Close food search"].tap()
        app.buttons["Settings"].tap()
        app.swipeUp()
        XCTAssertFalse(app.staticTexts["Updates"].exists)
        XCTAssertFalse(app.buttons["Force Check"].exists)
        capture("Settings without Updates section", app)
    }

    func testFriendCardScrollsAndDragsDownToDismiss() {
        let app = launch(["-seed-friend"])
        let friend = app.buttons["Open Avery's day"]
        XCTAssertTrue(friend.waitForExistence(timeout: 3))
        friend.tap()
        let diary = app.scrollViews["friend-diary"]
        XCTAssertTrue(diary.waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Friend food 1"].exists)
        capture("Native friend diary card", app)
        diary.swipeUp(); diary.swipeUp()
        XCTAssertTrue(app.staticTexts["Friend food 12"].isHittable, "The diary must still scroll within the card")
        XCTAssertTrue(app.buttons["Close friend's day"].isHittable, "Done stays available while the diary scrolls")
        app.buttons["Close friend's day"].tap()
        friend.tap()
        XCTAssertTrue(diary.waitForExistence(timeout: 3))
        let top = diary.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12))
        top.press(forDuration: 0.05, thenDragTo: top.withOffset(CGVector(dx: 0, dy: 480)), withVelocity: .fast, thenHoldForDuration: 0)
        XCTAssertTrue(app.textFields["ai-composer"].waitForExistence(timeout: 3), "Pulling down at the top should dismiss the card")
        XCTAssertFalse(app.buttons["Close friend's day"].exists)
    }

    func testGlassComposerSwitchesControlsAndPreservesConversation() {
        let app = launch(["-seed-chat"])
        let response = app.staticTexts["Try a chicken bowl with rice and vegetables."]
        XCTAssertTrue(response.waitForExistence(timeout: 3))
        capture("Liquid Glass conversation and composer", app)
        let composer = app.textFields["ai-composer"]
        composer.tap(); composer.typeText("Add lunch")
        XCTAssertTrue(app.buttons["Send message"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["voice-microphone"].exists)
        capture("Liquid Glass composer with keyboard and send button", app)
        composer.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 9))
        XCTAssertTrue(app.buttons["voice-microphone"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["Send message"].exists)
        app.buttons["Hide the food assistant conversation"].tap()
        XCTAssertFalse(response.exists)
        composer.tap()
        XCTAssertTrue(response.waitForExistence(timeout: 3), "Collapsing the glass panel must preserve its conversation")
        app.buttons["Hide the food assistant conversation"].tap()
        app.cells["Edit Grilled chicken"].tap()
        XCTAssertTrue(app.buttons["Close details"].waitForExistence(timeout: 3), "The empty area around glass controls must pass taps to the diary")
        app.buttons["Done"].tap()
        app.buttons["Settings"].tap()
        XCTAssertTrue(app.buttons["Close Settings"].waitForExistence(timeout: 3))
        capture("Native Settings navigation and toolbar", app)
        app.buttons["Close Settings"].tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 3))
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
        let chicken = app.cells["Edit Grilled chicken"]
        let source = chicken.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let edge = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.88))
        source.press(forDuration: 0.55, thenDragTo: edge, withVelocity: .slow, thenHoldForDuration: 3)
        let moved = app.cells["diary-row-snacks-Grilled chicken"]
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
        XCTAssertTrue(app.cells["Edit Quick add"].waitForExistence(timeout: 3))
        app.cells["Edit Quick add"].tap()
        XCTAssertEqual(app.textFields["Quick add calories"].value as? String, "400")
        replace(app.textFields["Quick add calories"], with: "450")
        app.buttons["Done"].tap()
        app.cells["Edit Quick add"].tap()
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
        XCTAssertTrue(app.cells["Edit Chicken bowl copy"].waitForExistence(timeout: 3))
        app.cells["Edit Chicken bowl copy"].tap()
        XCTAssertTrue(app.staticTexts["Ingredients"].exists)
        app.buttons["Edit ingredient Grilled chicken"].tap()
        app.buttons.matching(identifier: "Adjust portion +1/4").allElementsBoundByIndex.last!.tap()
        app.buttons["Done"].tap()
        app.cells["Edit Chicken bowl copy"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "1 1/4 portions")).firstMatch.exists)
        capture("Logged recipe with editable ingredient snapshot", app)
    }

    func testHoldAndSlideQuickCaloriesAndAddPortion() {
        let app = launch()
        app.buttons["Add food to Breakfast"].tap()
        let quick = app.buttons["Quick add"]
        let start = quick.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        start.press(forDuration: 0.55, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -160)))
        XCTAssertTrue(app.cells["Edit Quick add"].waitForExistence(timeout: 3))
        app.cells["Edit Quick add"].tap()
        XCTAssertEqual(app.textFields["Quick add calories"].value as? String, "250")
        app.buttons["Done"].tap()
        app.buttons["Add food to Breakfast"].tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Grilled chicken,")).firstMatch.tap()
        let add = app.buttons["Add to Breakfast"]
        let portion = add.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        portion.press(forDuration: 0.55, thenDragTo: portion.withOffset(CGVector(dx: 0, dy: -145)))
        XCTAssertTrue(app.cells["diary-row-breakfast-Grilled chicken"].waitForExistence(timeout: 3))
        app.cells["diary-row-breakfast-Grilled chicken"].tap()
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

    func testMealPlusHoldUpQuickAddsToEveryMeal() {
        let app = launch()
        for meal in ["Breakfast", "Lunch", "Dinner", "Snacks"] {
            let add = app.buttons["Add food to \(meal)"]
            for _ in 0..<4 where !add.isHittable || add.frame.midY > app.frame.height - 180 { app.swipeUp() }
            XCTAssertTrue(add.isHittable, "The \(meal) + should be reachable")
            let start = add.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            start.press(forDuration: 0.4, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -160)))
            let row = app.cells["diary-row-\(meal.lowercased())-Quick add"]
            XCTAssertTrue(row.waitForExistence(timeout: 3), "Quick add must stay in \(meal)")
            XCTAssertFalse(app.textFields["food-search"].exists, "Releasing a hold must not also open search")
            row.tap()
            XCTAssertEqual(app.textFields["Quick add calories"].value as? String, "250")
            app.buttons["Done"].tap()
        }
        capture("Quick calories added using each meal plus", app)
    }

    func testMealPlusHoldDownOpensBarcodeForSelectedMeal() {
        let app = launch()
        let breakfast = app.buttons["Add food to Breakfast"]
        let start = breakfast.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        start.press(forDuration: 0.4, thenDragTo: start.withOffset(CGVector(dx: 0, dy: 90)))
        let code = app.textFields["barcode-number"]
        XCTAssertTrue(code.waitForExistence(timeout: 5), "Sliding down should open the scanner directly")
        capture("Barcode scanner opened from meal plus", app)
        code.tap(); code.typeText("12345678")
        app.buttons["Look up barcode"].tap()
        XCTAssertEqual(app.textFields["food-search"].value as? String, "12345678")
        XCTAssertTrue(app.buttons["Add to Breakfast"].exists)
        app.buttons["Close food search"].tap()
        let lunch = app.buttons["Add food to Lunch"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        lunch.press(forDuration: 0.4, thenDragTo: lunch.withOffset(CGVector(dx: 0, dy: 70)))
        XCTAssertTrue(code.waitForExistence(timeout: 5))
        app.buttons["Done"].tap()
        XCTAssertTrue(app.buttons["Add to Lunch"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.cells["Edit Quick add"].exists)
    }

    func testMealPlusCancelsNeutralAndSidewaysHoldsAndUsesSelectedDate() {
        let app = launch()
        let add = app.buttons["Add food to Breakfast"]
        add.press(forDuration: 0.4)
        XCTAssertFalse(app.textFields["food-search"].exists)
        XCTAssertFalse(app.textFields["barcode-number"].exists)
        XCTAssertFalse(app.cells["Edit Quick add"].exists)
        let start = add.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        start.press(forDuration: 0.4, thenDragTo: start.withOffset(CGVector(dx: -150, dy: -160)))
        XCTAssertFalse(app.cells["Edit Quick add"].exists, "Moving away sideways cancels the selection")
        add.tap()
        XCTAssertTrue(app.textFields["food-search"].waitForExistence(timeout: 3), "Normal tap still opens food search")
        XCTAssertFalse(app.textFields["barcode-number"].exists)
        app.buttons["Close food search"].tap()
        let heading = app.descendants(matching: .any)["diary-heading"].firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.5))
        heading.press(forDuration: 0.05, thenDragTo: heading.withOffset(CGVector(dx: 160, dy: 0)))
        XCTAssertTrue(app.staticTexts["Yesterday"].waitForExistence(timeout: 3))
        let yesterday = add.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        yesterday.press(forDuration: 0.4, thenDragTo: yesterday.withOffset(CGVector(dx: 0, dy: -160)))
        XCTAssertTrue(app.cells["diary-row-breakfast-Quick add"].waitForExistence(timeout: 3))
        app.buttons["Back to today"].tap()
        XCTAssertFalse(app.cells["Edit Quick add"].exists, "Yesterday's quick add must not appear today")
    }
}
