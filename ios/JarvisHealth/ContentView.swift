import SwiftUI

struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase
    @EnvironmentObject private var healthKitManager: HealthKitManager
    @EnvironmentObject private var movementManager: MovementManager

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    headerCard
                    metricsCard
                    serverCard
                    movementCard
                    permissionCard
                }
                .padding(20)
            }
            .navigationTitle("Jarvis Health")
        }
        .task {
            healthKitManager.refreshAuthorizationStatus()
            movementManager.configureSync(baseURL: healthKitManager.selectedBaseURL)
            movementManager.handleAppBecameActive()
        }
        .onChange(of: healthKitManager.selectedBaseURL) { _, newValue in
            movementManager.configureSync(baseURL: newValue)
        }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .active {
                movementManager.handleAppBecameActive()
            }
        }
    }

    private var headerCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Connect Apple Health")
                .font(.title2.bold())

            Text("This starter app asks for read-only access to a few health metrics so Jarvis can later summarize them for you.")
                .foregroundStyle(.secondary)

            Label(healthKitManager.authorizationMessage, systemImage: healthKitManager.authorizationIcon)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(healthKitManager.authorizationColor)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private var metricsCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Requested Metrics")
                .font(.headline)

            ForEach(healthKitManager.requestedMetricLabels, id: \.self) { label in
                Label(label, systemImage: "checkmark.circle")
                    .foregroundStyle(.primary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private var serverCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Jarvis Server")
                .font(.headline)

            Picker("Server", selection: Binding(
                get: { healthKitManager.serverMode },
                set: { healthKitManager.updateServerMode($0) }
            )) {
                ForEach(JarvisServerMode.allCases) { mode in
                    Text(mode.title).tag(mode)
                }
            }
            .pickerStyle(.segmented)

            if healthKitManager.serverMode == .production {
                Text(healthKitManager.productionDisplayURL)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            if healthKitManager.serverMode == .local {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Local API Base URL")
                        .font(.subheadline.weight(.medium))
                    TextField(
                        "http://192.168.0.198:8000/api",
                        text: Binding(
                            get: { healthKitManager.localBaseURL },
                            set: { healthKitManager.updateLocalBaseURL($0) }
                        )
                    )
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                    .autocorrectionDisabled()
                    .textFieldStyle(.roundedBorder)
                }
            }

            if healthKitManager.serverMode == .custom {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Custom API Base URL")
                        .font(.subheadline.weight(.medium))
                    TextField(
                        "https://jarvis.jarom.ink/api",
                        text: Binding(
                            get: { healthKitManager.customBaseURL },
                            set: { healthKitManager.updateCustomBaseURL($0) }
                        )
                    )
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                    .autocorrectionDisabled()
                    .textFieldStyle(.roundedBorder)
                }
            }

            Text("Current sync target: \(healthKitManager.selectedBaseURL)")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private var movementCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Movement Journal")
                .font(.headline)

            Text(movementManager.authorizationMessage)
                .font(.subheadline)
                .foregroundStyle(.secondary)

            Text("Tracking and syncing run automatically after permission is granted. The controls below are mainly for setup and fallback.")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            if let errorMessage = movementManager.errorMessage {
                Text(errorMessage)
                    .font(.subheadline)
                    .foregroundStyle(.red)
            }

            HStack {
                Button("Enable Location") {
                    movementManager.requestAuthorization()
                }
                .buttonStyle(.bordered)

                Button(movementManager.isTracking ? "Stop Tracking" : "Start Tracking") {
                    if movementManager.isTracking {
                        movementManager.stopTracking()
                    } else {
                        movementManager.startTracking()
                    }
                }
                .buttonStyle(.borderedProminent)
            }

            Button("Sync Movement to Jarvis") {
                Task {
                    await movementManager.syncTodayToJarvis(baseURL: healthKitManager.selectedBaseURL)
                }
            }
            .buttonStyle(.bordered)

            if let summary = movementManager.todaySummary {
                Text(summary)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            if let syncMessage = movementManager.syncMessage {
                Text(syncMessage)
                    .font(.subheadline)
                    .foregroundStyle(.green)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private var permissionCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Health Access")
                .font(.headline)

            if let errorMessage = healthKitManager.errorMessage {
                Text(errorMessage)
                    .font(.subheadline)
                    .foregroundStyle(.red)
            }

            Button {
                Task {
                    await healthKitManager.requestAuthorization()
                }
            } label: {
                HStack {
                    if healthKitManager.isRequestInFlight {
                        ProgressView()
                            .tint(.white)
                    }

                    Text(healthKitManager.buttonTitle)
                        .fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(healthKitManager.isRequestInFlight || !healthKitManager.isHealthDataAvailable)

            if healthKitManager.hasRequestedAuthorization {
                HStack {
                    Button("Load Today's Sample Data") {
                        Task {
                            await healthKitManager.loadTodaySummary()
                        }
                    }
                    .buttonStyle(.bordered)

                    Button {
                        Task {
                            await healthKitManager.syncTodayToJarvis()
                        }
                    } label: {
                        HStack {
                            if healthKitManager.isSyncInFlight {
                                ProgressView()
                            }
                            Text(healthKitManager.isSyncInFlight ? "Syncing..." : "Sync to Jarvis")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(healthKitManager.isSyncInFlight)
                }

                if let summary = healthKitManager.todaySummary {
                    Text(summary)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                if let syncMessage = healthKitManager.syncMessage {
                    Text(syncMessage)
                        .font(.subheadline)
                        .foregroundStyle(.green)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
}

#Preview {
    ContentView()
        .environmentObject(HealthKitManager())
}
