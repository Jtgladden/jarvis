# iOS Companion App

This folder contains a starter SwiftUI companion app for Apple Health access.

## What is included

- `JarvisHealthApp.swift`: SwiftUI entry point
- `ContentView.swift`: simple connect/status screen
- `HealthKitManager.swift`: HealthKit authorization and sample reads
- `Info.plist`: privacy usage descriptions
- `JarvisHealth.entitlements`: enables the HealthKit capability

## What is not included

This workspace does not currently have a working Xcode project file because the active developer tools on this machine do not include full Xcode. To finish setup:

1. Open Xcode on your Mac.
2. Create a new iOS App project named `JarvisHealth`.
3. Replace the generated Swift files with the files from this folder.
4. Replace the generated `Info.plist` values with the entries in this folder.
5. Add the `JarvisHealth.entitlements` file to the target.
6. In Signing & Capabilities, add the `HealthKit` capability.
7. Build and run on your iPhone.
8. The app now supports `Production`, `Local`, and `Custom` server modes in-app.

Default plist values:

- `JarvisProductionAPIBaseURL=https://jarvis.jarom.ink/api`
- `JarvisLocalAPIBaseURL=http://192.168.0.198:8000/api`

You can still update these defaults in `Info.plist`, but the app now lets you switch servers without editing the plist every time.

## Initial data types requested

- Steps
- Heart rate
- Sleep analysis
- Active energy burned
- Workouts

## Next step

After permission succeeds, the app can now post a daily health summary to the Jarvis backend with the `Sync to Jarvis` button.
