# Caloric branding

Bento is the selected app icon. `icons/` keeps all six proposals as editable SVGs and 1024px PNGs; open `icons/index.html` to compare them. `wordmarks/` keeps the three supplied source wordmarks.

`palette.json` contains the orange accents and neutral light/dark fallbacks. Native iOS surfaces, text and separators use UIKit system colors; nutrition and status colors keep their established meaning. Deeper orange text in light mode and apricot in dark mode preserve readable contrast.

After changing the selected SVG or palette, run from the repository root:

```sh
node mobile/scripts/generate-brand-assets.js
```

This regenerates Swift and Expo icons, widget palettes and shared Expo tokens. Web tokens in `backend/web/style.css` follow the same palette, and its build copies the shared icon/favicon. Publishing each app is a separate action; only Caloric Swift is released for this change.
