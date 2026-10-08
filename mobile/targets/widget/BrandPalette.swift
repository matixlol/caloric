// Generated from design/brand/palette.json by generate-brand-assets.js.
import SwiftUI
import UIKit

enum BrandPalette {
    static let accent = Color(uiColor: UIColor(red: 1.000000, green: 0.517647, blue: 0.000000, alpha: 1))
    static let ink = Color(uiColor: UIColor(red: 0.133333, green: 0.137255, blue: 0.113725, alpha: 1))
    static let background = Color(uiColor: .systemGroupedBackground)
    static let card = Color(uiColor: .secondarySystemGroupedBackground)
    static let inputBackground = Color(uiColor: .tertiarySystemGroupedBackground)
    static let label = Color(uiColor: .label)
    static let secondaryLabel = Color(uiColor: .secondaryLabel)
    static let separator = Color(uiColor: .separator)
    static let tint = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark ? UIColor(red: 1.000000, green: 0.647059, blue: 0.211765, alpha: 1) : UIColor(red: 0.678431, green: 0.301961, blue: 0.000000, alpha: 1)
    })
    static let buttonText = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark ? UIColor(red: 0.133333, green: 0.137255, blue: 0.113725, alpha: 1) : UIColor(red: 1.000000, green: 1.000000, blue: 1.000000, alpha: 1)
    })
}
