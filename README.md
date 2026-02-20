# Welcome to your Expo app 👋

This is an [Expo](https://expo.dev) project created with [`create-expo-app`](https://www.npmjs.com/package/create-expo-app).

## Clerk Auth + Jazz

This project now uses Clerk for user login and `JazzExpoProviderWithClerk` for Jazz account auth.

### Local env

Create `.env.local` with:

```bash
EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_your-clerk-publishable-key
EXPO_PUBLIC_JAZZ_API_KEY=your-jazz-api-key
EXPO_PUBLIC_BACKEND_URL=https://backend.caloric.mati.lol
```

You can create a publishable key in the [Clerk Dashboard](https://dashboard.clerk.com/).
`EXPO_PUBLIC_BACKEND_URL` is optional and defaults to `https://backend.caloric.mati.lol` in the app.

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

## Backend Service

This repo also includes a Bun backend in `backend/` that proxies MyFitnessPal search/detail APIs and stores all upstream responses in Postgres using Drizzle migrations.

Quick start:

```bash
cd backend
bun install
cp .env.example .env
bun run db:generate
bun run db:migrate
bun run dev
```

## Deployed Backend API

Base URL: `https://backend.caloric.mati.lol`

- Health check: `GET https://backend.caloric.mati.lol/health`
- Search only: `GET https://backend.caloric.mati.lol/search?query=banana&maxItems=3&includeDetails=false`
- Search + detail payloads: `GET https://backend.caloric.mati.lol/search?query=banana&maxItems=1&includeDetails=true`
- Start AI session: `POST https://backend.caloric.mati.lol/ai/session` with `{ "userId": "..." }`
- Run AI turn: `POST https://backend.caloric.mati.lol/ai/turn` with `{ "sessionId": "...", "userId": "...", "action": { ... } }`

Note: there is no separate public detail endpoint right now; detail records are returned in the `details` array on `/search` when `includeDetails=true`.
