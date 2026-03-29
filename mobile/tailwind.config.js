/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,jsx,ts,tsx}", "./src/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        cream: "#FFFFFF",
        ink: "#104028",
        night: "#000000",
        pine: "#173323",
        mint: "#D9F2E2",
        moss: "#89B79B",
        line: "#1E2A23",
      },
    },
  },
  plugins: [],
};
