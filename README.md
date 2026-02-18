# Welcome to your Expo app 👋

This is an [Expo](https://expo.dev) project created with [`create-expo-app`](https://www.npmjs.com/package/create-expo-app).

## Passkey Auth on `caloric.mati.lol`

This project is configured for Jazz passkeys using:

- `EXPO_PUBLIC_JAZZ_RP_ID=caloric.mati.lol`
- iOS associated domain `webcredentials:caloric.mati.lol`
- Cloudflare Worker route for:
  - `/.well-known/apple-app-site-association`
  - `/.well-known/assetlinks.json`

### One-time Cloudflare setup

1. Authenticate Wrangler:

   ```bash
   npx wrangler login
   npx wrangler whoami
   ```

2. Set passkey metadata vars in `cloudflare/passkeys/wrangler.jsonc`:

   ```bash
   APPLE_TEAM_ID
   IOS_BUNDLE_ID
   ANDROID_PACKAGE_NAME
   ANDROID_SHA256_CERT_FINGERPRINTS
   ```

   `ANDROID_SHA256_CERT_FINGERPRINTS` supports one or more comma-separated SHA256 cert fingerprints.
   Use your release signing cert fingerprint for production Android passkeys.

3. Deploy Worker + static files:

   ```bash
   npm run cf:deploy
   ```

### Local env

Create `.env.local` with:

```bash
EXPO_PUBLIC_JAZZ_API_KEY=your-jazz-api-key
EXPO_PUBLIC_JAZZ_RP_ID=caloric.mati.lol
```

## Get started

1. Install dependencies

   ```bash
   npm install
   ```

2. Start the app

   ```bash
   npx expo start
   ```

In the output, you'll find options to open the app in a

- [development build](https://docs.expo.dev/develop/development-builds/introduction/)
- [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/)
- [iOS simulator](https://docs.expo.dev/workflow/ios-simulator/)
- [Expo Go](https://expo.dev/go), a limited sandbox for trying out app development with Expo

You can start developing by editing the files inside the **app** directory. This project uses [file-based routing](https://docs.expo.dev/router/introduction).

## Get a fresh project

When you're ready, run:

```bash
npm run reset-project
```

This command will move the starter code to the **app-example** directory and create a blank **app** directory where you can start developing.

## Learn more

To learn more about developing your project with Expo, look at the following resources:

- [Expo documentation](https://docs.expo.dev/): Learn fundamentals, or go into advanced topics with our [guides](https://docs.expo.dev/guides).
- [Learn Expo tutorial](https://docs.expo.dev/tutorial/introduction/): Follow a step-by-step tutorial where you'll create a project that runs on Android, iOS, and the web.

## Join the community

Join our community of developers creating universal apps.

- [Expo on GitHub](https://github.com/expo/expo): View our open source platform and contribute.
- [Discord community](https://chat.expo.dev): Chat with Expo users and ask questions.
