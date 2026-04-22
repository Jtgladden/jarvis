import Foundation
import HealthKit
import SwiftUI

enum JarvisServerMode: String, CaseIterable, Identifiable {
    case production
    case local
    case custom

    var id: String { rawValue }

    var title: String {
        switch self {
        case .production:
            return "Production"
        case .local:
            return "Local"
        case .custom:
            return "Custom"
        }
    }
}

struct HealthSyncPayload: Encodable {
    let date: String
    let source: String
    let steps: Int
    let active_energy_kcal: Double?
    let sleep_hours: Double?
    let workouts: Int
    let resting_heart_rate: Double?
    let extra_metrics: [String: Double?]
}

struct WorkoutRoutePointSyncPayload: Encodable {
    let timestamp: String
    let latitude: Double
    let longitude: Double
    let altitude_m: Double?
    let horizontal_accuracy_m: Double?
    let vertical_accuracy_m: Double?
}

struct WorkoutSyncPayload: Encodable {
    let workout_id: String
    let date: String
    let source: String
    let activity_type: String
    let activity_label: String
    let start_date: String
    let end_date: String
    let duration_minutes: Double
    let total_distance_km: Double?
    let active_energy_kcal: Double?
    let avg_heart_rate_bpm: Double?
    let max_heart_rate_bpm: Double?
    let source_name: String?
    let route_points: [WorkoutRoutePointSyncPayload]
}

struct WorkoutBatchSyncPayload: Encodable {
    let workouts: [WorkoutSyncPayload]
}

struct WorkoutSyncCandidate {
    let workoutID: String
    let date: String
    let source: String
    let activityType: String
    let activityLabel: String
    let startDate: String
    let endDate: String
    let durationMinutes: Double
    let totalDistanceKM: Double?
    let activeEnergyKcal: Double?
    let avgHeartRateBPM: Double?
    let maxHeartRateBPM: Double?
    let sourceName: String?
    let routePoints: [WorkoutRoutePointSyncPayload]
}

struct TodayHealthSnapshot {
    let date: String
    let steps: Double
    let activeEnergy: Double?
    let sleepHours: Double?
    let workouts: Int
    let restingHeartRate: Double?
    let extraMetrics: [String: Double?]
}

private enum QuantityMetricDefinition {
    case cumulative(HKQuantityTypeIdentifier, HKUnit, String)
    case average(HKQuantityTypeIdentifier, HKUnit, String)
    case latest(HKQuantityTypeIdentifier, HKUnit, String)
}

@MainActor
final class HealthKitManager: ObservableObject {
    private enum StorageKeys {
        static let serverMode = "jarvis_server_mode"
        static let localBaseURL = "jarvis_local_base_url"
        static let customBaseURL = "jarvis_custom_base_url"
    }

    private enum AutoSync {
        static let minimumInterval: TimeInterval = 15 * 60
        static let workoutSyncDays = 30
        static let workoutMinimumInterval: TimeInterval = 12 * 60 * 60
    }

    @Published var isHealthDataAvailable = HKHealthStore.isHealthDataAvailable()
    @Published var isRequestInFlight = false
    @Published var isSyncInFlight = false
    @Published var hasRequestedAuthorization = false
    @Published var errorMessage: String?
    @Published var todaySummary: String?
    @Published var syncMessage: String?
    @Published var lastSuccessfulSyncBaseURL: String?
    @Published var lastAutoSyncAt: Date?
    @Published var lastAutoSyncReason: String?
    @Published var lastAutoSyncStatus: String?
    @Published var isHistorySyncInFlight = false
    @Published var historySyncProgress: String?
    @Published var isWorkoutSyncInFlight = false
    @Published var workoutSyncProgress: String?
    @Published var serverMode: JarvisServerMode
    @Published var localBaseURL: String
    @Published var customBaseURL: String

    let requestedMetricLabels = [
        "Steps",
        "Walking + running distance",
        "Flights climbed",
        "Active energy burned",
        "Basal energy burned",
        "Exercise minutes",
        "Stand hours",
        "Walking speed",
        "Walking step length",
        "VO2 max",
        "Heart rate",
        "Resting heart rate",
        "Walking heart rate average",
        "Heart rate variability",
        "Respiratory rate",
        "Oxygen saturation",
        "Body temperature",
        "Body weight",
        "Body fat percentage",
        "BMI",
        "Water intake",
        "Sleep analysis",
        "Workouts",
    ]

    private let healthStore = HKHealthStore()
    private let productionBaseURL: String
    private let defaultLocalBaseURL: String
    private let userDefaults: UserDefaults
    private var syncTask: Task<Void, Never>?
    private var lastAutoSyncAttemptAt: Date?
    private var lastAutoWorkoutSyncAt: Date?
    private var configuredBaseURL: String?

    private let quantityMetrics: [QuantityMetricDefinition] = [
        .cumulative(.stepCount, .count(), "steps"),
        .cumulative(.distanceWalkingRunning, .meterUnit(with: .kilo), "walking_running_distance_km"),
        .cumulative(.flightsClimbed, .count(), "flights_climbed"),
        .cumulative(.activeEnergyBurned, .kilocalorie(), "active_energy_kcal"),
        .cumulative(.basalEnergyBurned, .kilocalorie(), "basal_energy_kcal"),
        .cumulative(.appleExerciseTime, .minute(), "exercise_minutes"),
        .cumulative(.appleStandTime, .minute(), "stand_minutes"),
        .latest(.walkingSpeed, HKUnit.meter().unitDivided(by: .second()), "walking_speed_mps"),
        .latest(.walkingStepLength, .meter(), "walking_step_length_m"),
        .latest(.vo2Max, HKUnit(from: "ml/kg*min"), "vo2_max"),
        .average(.heartRate, HKUnit.count().unitDivided(by: .minute()), "avg_heart_rate_bpm"),
        .latest(.heartRate, HKUnit.count().unitDivided(by: .minute()), "latest_heart_rate_bpm"),
        .latest(.restingHeartRate, HKUnit.count().unitDivided(by: .minute()), "resting_heart_rate_bpm"),
        .latest(.walkingHeartRateAverage, HKUnit.count().unitDivided(by: .minute()), "walking_heart_rate_avg_bpm"),
        .latest(.heartRateVariabilitySDNN, .secondUnit(with: .milli), "hrv_sdnn_ms"),
        .latest(.respiratoryRate, HKUnit.count().unitDivided(by: .minute()), "respiratory_rate_bpm"),
        .latest(.oxygenSaturation, .percent(), "oxygen_saturation_percent"),
        .latest(.bodyTemperature, .degreeCelsius(), "body_temperature_c"),
        .latest(.bodyMass, .gramUnit(with: .kilo), "body_mass_kg"),
        .latest(.bodyFatPercentage, .percent(), "body_fat_percentage"),
        .latest(.bodyMassIndex, HKUnit.count(), "body_mass_index"),
        .cumulative(.dietaryWater, .literUnit(with: .milli), "water_intake_ml"),
    ]

    init(
        userDefaults: UserDefaults = .standard,
        bundle: Bundle = .main
    ) {
        self.userDefaults = userDefaults
        self.productionBaseURL = (bundle.object(forInfoDictionaryKey: "JarvisProductionAPIBaseURL") as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? "https://jarvis.jarom.ink/api"
        self.defaultLocalBaseURL = (bundle.object(forInfoDictionaryKey: "JarvisLocalAPIBaseURL") as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? "http://192.168.0.198:8000/api"

        let storedMode = userDefaults.string(forKey: StorageKeys.serverMode)
        self.serverMode = JarvisServerMode(rawValue: storedMode ?? "") ?? .production
        self.localBaseURL = userDefaults.string(forKey: StorageKeys.localBaseURL) ?? self.defaultLocalBaseURL
        self.customBaseURL = userDefaults.string(forKey: StorageKeys.customBaseURL) ?? ""
        self.configuredBaseURL = nil
    }

    var buttonTitle: String {
        hasRequestedAuthorization ? "Review Apple Health Access" : "Connect Apple Health"
    }

    var authorizationMessage: String {
        if !isHealthDataAvailable {
            return "Health data is not available on this device."
        }

        if hasRequestedAuthorization {
            return "Apple Health access has been requested. Use the sync button to send a broader metrics snapshot to Jarvis."
        }

        return "Apple Health access has not been granted yet."
    }

    var authorizationIcon: String {
        hasRequestedAuthorization ? "heart.text.square.fill" : "heart"
    }

    var authorizationColor: Color {
        hasRequestedAuthorization ? .green : .orange
    }

    var selectedBaseURL: String {
        switch serverMode {
        case .production:
            return productionBaseURL
        case .local:
            return normalizedBaseURL(localBaseURL)
        case .custom:
            return normalizedBaseURL(customBaseURL)
        }
    }

    var productionDisplayURL: String {
        productionBaseURL
    }

    var lastAutoSyncSummary: String {
        guard let lastAutoSyncAt else {
            return "No automatic Health sync has happened yet."
        }

        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        let timestamp = formatter.string(from: lastAutoSyncAt)

        if let lastAutoSyncReason, !lastAutoSyncReason.isEmpty {
            return "\(timestamp) from \(lastAutoSyncReason)."
        }

        return "\(timestamp)."
    }

    func updateServerMode(_ mode: JarvisServerMode) {
        serverMode = mode
        userDefaults.set(mode.rawValue, forKey: StorageKeys.serverMode)
        configureAutomaticSync(baseURL: selectedBaseURL)
    }

    func updateLocalBaseURL(_ value: String) {
        localBaseURL = value
        userDefaults.set(value, forKey: StorageKeys.localBaseURL)
        if serverMode == .local {
            configureAutomaticSync(baseURL: selectedBaseURL)
        }
    }

    func updateCustomBaseURL(_ value: String) {
        customBaseURL = value
        userDefaults.set(value, forKey: StorageKeys.customBaseURL)
        if serverMode == .custom {
            configureAutomaticSync(baseURL: selectedBaseURL)
        }
    }

    func configureAutomaticSync(baseURL: String) {
        configuredBaseURL = normalizedBaseURL(baseURL)
        scheduleAutomaticSync(reason: "server updated")
    }

    func handleAppBecameActive() {
        refreshAuthorizationStatus()
        scheduleAutomaticSync(reason: "app active")
    }

    func refreshAuthorizationStatus() {
        guard isHealthDataAvailable else {
            hasRequestedAuthorization = false
            return
        }

        Task {
            do {
                let status = try await authorizationRequestStatus()
                hasRequestedAuthorization = status == .unnecessary
                if hasRequestedAuthorization {
                    scheduleAutomaticSync(reason: "authorization refreshed")
                }
            } catch {
                errorMessage = "Unable to determine Health access state: \(error.localizedDescription)"
            }
        }
    }

    func requestAuthorization() async {
        guard isHealthDataAvailable else {
            errorMessage = "Apple Health is unavailable on this device."
            return
        }

        isRequestInFlight = true
        errorMessage = nil

        do {
            try await healthStore.requestAuthorization(toShare: [], read: requestedObjectTypes)
            hasRequestedAuthorization = true
            await loadTodaySummary()
            scheduleAutomaticSync(reason: "authorization granted")
        } catch {
            errorMessage = "Authorization failed: \(error.localizedDescription)"
        }

        isRequestInFlight = false
    }

    func loadTodaySummary() async {
        guard hasRequestedAuthorization else {
            todaySummary = nil
            return
        }

        do {
            let snapshot = try await fetchTodaySnapshot()
            hasRequestedAuthorization = true
            todaySummary = buildSummaryText(from: snapshot)
        } catch {
            errorMessage = "Unable to load sample data: \(error.localizedDescription)"
        }
    }

    func syncTodayToJarvis() async {
        guard hasRequestedAuthorization else {
            syncMessage = nil
            errorMessage = "Connect Apple Health before syncing to Jarvis."
            return
        }

        isSyncInFlight = true
        errorMessage = nil
        syncMessage = nil

        do {
            let snapshot = try await fetchTodaySnapshot()
            let successfulBaseURL = try await postSnapshotToJarvis(snapshot)
            todaySummary = buildSummaryText(from: snapshot)
            lastSuccessfulSyncBaseURL = successfulBaseURL
            syncMessage = "Synced today's expanded Apple Health metrics to Jarvis via \(successfulBaseURL)."
        } catch {
            errorMessage = "Jarvis sync failed: \(error.localizedDescription)"
        }

        isSyncInFlight = false
    }

    func syncAllAvailableHistoryToJarvis() async {
        guard hasRequestedAuthorization else {
            syncMessage = nil
            errorMessage = "Connect Apple Health before syncing history to Jarvis."
            return
        }

        isHistorySyncInFlight = true
        errorMessage = nil
        syncMessage = nil
        historySyncProgress = "Looking for the oldest available Health data..."

        do {
            guard let oldestSampleDate = try await fetchOldestSampleDate() else {
                historySyncProgress = nil
                syncMessage = "No historical Apple Health samples were found to backfill."
                isHistorySyncInFlight = false
                return
            }

            let calendar = Calendar.current
            let todayStart = calendar.startOfDay(for: Date())
            let firstDay = calendar.startOfDay(for: oldestSampleDate)
            let totalDays = max(1, calendar.dateComponents([.day], from: firstDay, to: todayStart).day ?? 0 + 1)
            let candidateBaseURLs = resolvedBaseURLsForSync()

            var syncedDays = 0
            var daysWithData = 0
            var successfulBaseURL: String?
            var currentDay = firstDay
            var dayIndex = 0

            while currentDay <= todayStart {
                dayIndex += 1
                historySyncProgress = "Syncing health history day \(dayIndex) of \(totalDays)..."

                guard let nextDay = calendar.date(byAdding: .day, value: 1, to: currentDay) else {
                    break
                }

                let snapshot = try await fetchSnapshot(
                    startDate: currentDay,
                    endDate: nextDay,
                    includeLatestValuesFromEntireStore: false
                )

                if snapshotHasMeaningfulData(snapshot) {
                    daysWithData += 1
                    successfulBaseURL = try await postSnapshotToJarvis(snapshot, candidateBaseURLs: candidateBaseURLs)
                    syncedDays += 1
                }

                currentDay = nextDay
            }

            historySyncProgress = nil
            lastSuccessfulSyncBaseURL = successfulBaseURL
            if let successfulBaseURL {
                syncMessage = "Backfilled \(syncedDays) Health days from \(Self.isoDateString(for: firstDay)) through \(Self.isoDateString(for: todayStart)) via \(successfulBaseURL)."
            } else {
                syncMessage = "Scanned \(totalDays) days of Health history but did not find any days with data to sync."
            }
            todaySummary = "Historical sync scanned \(totalDays) days and found \(daysWithData) days with Apple Health data."

            let workoutDays = max(totalDays, 30)
            let workoutBaseURL = try await syncWorkoutHistoryToJarvis(days: workoutDays, silent: true)
            if let workoutBaseURL {
                let prefix = syncMessage.map { "\($0) " } ?? ""
                syncMessage = prefix + "Workout history synced via \(workoutBaseURL)."
            }
        } catch {
            historySyncProgress = nil
            errorMessage = "Jarvis history sync failed: \(error.localizedDescription)"
        }

        isHistorySyncInFlight = false
    }

    func syncWorkoutHistoryToJarvis(days: Int = 90, silent: Bool = false) async throws -> String? {
        guard hasRequestedAuthorization else {
            if !silent {
                syncMessage = nil
                errorMessage = "Connect Apple Health before syncing workout history to Jarvis."
            }
            return nil
        }

        if !silent {
            isWorkoutSyncInFlight = true
            errorMessage = nil
            workoutSyncProgress = "Loading workouts from Apple Health..."
        }

        defer {
            if !silent {
                isWorkoutSyncInFlight = false
                workoutSyncProgress = nil
            }
        }

        let workouts = try await fetchWorkoutCandidates(days: days, reportProgress: !silent)
        guard !workouts.isEmpty else {
            if !silent {
                syncMessage = "No workouts were found in the last \(days) days."
            }
            return nil
        }

        if !silent {
            workoutSyncProgress = "Uploading \(workouts.count) workouts to Jarvis..."
        }

        let successfulBaseURL = try await postWorkoutsToJarvis(workouts)
        if !silent {
            syncMessage = "Synced \(workouts.count) workouts to Jarvis via \(successfulBaseURL)."
        }
        return successfulBaseURL
    }

    private func scheduleAutomaticSync(reason: String) {
        guard hasRequestedAuthorization else {
            return
        }

        guard let baseURL = configuredBaseURL, !baseURL.isEmpty else {
            return
        }

        if isSyncInFlight || isHistorySyncInFlight || isWorkoutSyncInFlight {
            return
        }

        if let lastAutoSyncAttemptAt, Date().timeIntervalSince(lastAutoSyncAttemptAt) < AutoSync.minimumInterval {
            return
        }

        syncTask?.cancel()
        syncTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(6))

            guard !Task.isCancelled else {
                return
            }

            await performAutomaticSync(baseURL: baseURL, reason: reason)
        }
    }

    private func performAutomaticSync(baseURL: String, reason: String) async {
        guard hasRequestedAuthorization else {
            return
        }

        lastAutoSyncAttemptAt = Date()
        errorMessage = nil
        lastAutoSyncReason = reason

        do {
            let snapshot = try await fetchTodaySnapshot()
            let successfulBaseURL = try await postSnapshotToJarvis(snapshot, candidateBaseURLs: [baseURL])
            todaySummary = buildSummaryText(from: snapshot)
            lastSuccessfulSyncBaseURL = successfulBaseURL
            lastAutoSyncAt = Date()
            lastAutoSyncStatus = "Success"
            syncMessage = "Auto-synced Apple Health (\(reason)) via \(successfulBaseURL)."

            if shouldAutoSyncWorkouts(after: snapshot) {
                let workouts = try await fetchWorkoutCandidates(days: AutoSync.workoutSyncDays, reportProgress: false)
                if !workouts.isEmpty {
                    let workoutBaseURL = try await postWorkoutsToJarvis(workouts, candidateBaseURLs: [baseURL])
                    lastSuccessfulSyncBaseURL = workoutBaseURL
                    lastAutoSyncAt = Date()
                    lastAutoWorkoutSyncAt = Date()
                    lastAutoSyncStatus = "Success"
                    syncMessage = "Auto-synced Apple Health and workouts (\(reason)) via \(workoutBaseURL)."
                }
            }
        } catch {
            lastAutoSyncStatus = "Failed"
            errorMessage = "Automatic Health sync failed: \(error.localizedDescription)"
        }
    }

    private var requestedObjectTypes: Set<HKObjectType> {
        var objectTypes: Set<HKObjectType> = []

        for metric in quantityMetrics {
            switch metric {
            case .cumulative(let identifier, _, _),
                    .average(let identifier, _, _),
                    .latest(let identifier, _, _):
                if let type = HKObjectType.quantityType(forIdentifier: identifier) {
                    objectTypes.insert(type)
                }
            }
        }

        if let sleepType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) {
            objectTypes.insert(sleepType)
        }
        objectTypes.insert(HKObjectType.workoutType())
        objectTypes.insert(HKSeriesType.workoutRoute())

        return objectTypes
    }

    private func fetchTodaySnapshot() async throws -> TodayHealthSnapshot {
        let now = Date()
        let startOfDay = Calendar.current.startOfDay(for: now)
        return try await fetchSnapshot(
            startDate: startOfDay,
            endDate: now,
            includeLatestValuesFromEntireStore: true
        )
    }

    private func fetchSnapshot(
        startDate: Date,
        endDate: Date,
        includeLatestValuesFromEntireStore: Bool
    ) async throws -> TodayHealthSnapshot {
        async let metricMap = fetchRequestedMetrics(
            startDate: startDate,
            endDate: endDate,
            includeLatestValuesFromEntireStore: includeLatestValuesFromEntireStore
        )
        async let sleepHours = fetchSleepHoursIfAvailable(startDate: startDate, endDate: endDate)
        async let workouts = fetchWorkoutCount(startDate: startDate, endDate: endDate)

        let resolvedMetricMap = try await metricMap
        let resolvedSleepHours = await sleepHours
        let resolvedWorkouts = try await workouts
        let resolvedSteps = (resolvedMetricMap["steps"] ?? nil) ?? 0

        return TodayHealthSnapshot(
            date: Self.isoDateString(for: startDate),
            steps: resolvedSteps,
            activeEnergy: resolvedMetricMap["active_energy_kcal"] ?? nil,
            sleepHours: resolvedSleepHours,
            workouts: resolvedWorkouts,
            restingHeartRate: resolvedMetricMap["resting_heart_rate_bpm"] ?? nil,
            extraMetrics: resolvedMetricMap
        )
    }

    private func buildSummaryText(from snapshot: TodayHealthSnapshot) -> String {
        var fragments = ["\(Int(snapshot.steps)) steps"]

        if let distanceKM = snapshot.extraMetrics["walking_running_distance_km"] ?? nil {
            fragments.append(String(format: "%.1f mi walked", Self.miles(fromKilometers: distanceKM)))
        }

        if let activeEnergy = snapshot.activeEnergy {
            fragments.append("\(Int(activeEnergy)) active calories")
        }
        fragments.append("\(snapshot.workouts) workouts")

        if let sleepHours = snapshot.sleepHours {
            fragments.append(String(format: "%.1f hr sleep", sleepHours))
        }
        if let restingHeartRate = snapshot.restingHeartRate {
            fragments.append("\(Int(restingHeartRate)) bpm resting HR")
        }

        return "Today so far: " + fragments.joined(separator: ", ") + "."
    }

    private func fetchRequestedMetrics(
        startDate: Date,
        endDate: Date,
        includeLatestValuesFromEntireStore: Bool
    ) async throws -> [String: Double?] {
        var results: [String: Double?] = [:]
        let dayPredicate = Self.samplePredicate(startDate: startDate, endDate: endDate)

        for metric in quantityMetrics {
            switch metric {
            case .cumulative(let identifier, let unit, let key):
                results[key] = await fetchQuantityMetricIfAvailable(
                    identifier: identifier,
                    unit: unit,
                    mode: .cumulative,
                    predicate: dayPredicate
                )
            case .average(let identifier, let unit, let key):
                results[key] = await fetchQuantityMetricIfAvailable(
                    identifier: identifier,
                    unit: unit,
                    mode: .average,
                    predicate: dayPredicate
                )
            case .latest(let identifier, let unit, let key):
                results[key] = await fetchQuantityMetricIfAvailable(
                    identifier: identifier,
                    unit: unit,
                    mode: .latest,
                    predicate: includeLatestValuesFromEntireStore ? nil : dayPredicate
                )
            }
        }

        return results
    }

    private enum QuantityFetchMode {
        case cumulative
        case average
        case latest
    }

    private func fetchQuantityMetricIfAvailable(
        identifier: HKQuantityTypeIdentifier,
        unit: HKUnit,
        mode: QuantityFetchMode,
        predicate: NSPredicate?
    ) async -> Double? {
        do {
            switch mode {
            case .cumulative:
                return try await fetchCumulativeQuantity(identifier: identifier, unit: unit, predicate: predicate)
            case .average:
                return try await fetchAverageQuantity(identifier: identifier, unit: unit, predicate: predicate)
            case .latest:
                return try await fetchLatestQuantity(identifier: identifier, unit: unit, predicate: predicate)
            }
        } catch {
            return nil
        }
    }

    private func fetchCumulativeQuantity(
        identifier: HKQuantityTypeIdentifier,
        unit: HKUnit,
        predicate: NSPredicate?
    ) async throws -> Double? {
        guard let type = HKObjectType.quantityType(forIdentifier: identifier) else {
            return nil
        }

        let quantity: HKQuantity? = try await withCheckedThrowingContinuation { continuation in
            let query = HKStatisticsQuery(
                quantityType: type,
                quantitySamplePredicate: predicate,
                options: .cumulativeSum
            ) { _, statistics, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }

                continuation.resume(returning: statistics?.sumQuantity())
            }

            healthStore.execute(query)
        }

        return quantity?.doubleValue(for: unit)
    }

    private func fetchAverageQuantity(
        identifier: HKQuantityTypeIdentifier,
        unit: HKUnit,
        predicate: NSPredicate?
    ) async throws -> Double? {
        guard let type = HKObjectType.quantityType(forIdentifier: identifier) else {
            return nil
        }

        let quantity: HKQuantity? = try await withCheckedThrowingContinuation { continuation in
            let query = HKStatisticsQuery(
                quantityType: type,
                quantitySamplePredicate: predicate,
                options: .discreteAverage
            ) { _, statistics, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }

                continuation.resume(returning: statistics?.averageQuantity())
            }

            healthStore.execute(query)
        }

        return quantity?.doubleValue(for: unit)
    }

    private func fetchLatestQuantity(
        identifier: HKQuantityTypeIdentifier,
        unit: HKUnit,
        predicate: NSPredicate?
    ) async throws -> Double? {
        guard let type = HKObjectType.quantityType(forIdentifier: identifier) else {
            return nil
        }

        return try await withCheckedThrowingContinuation { continuation in
            let sortDescriptors = [NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)]
            let query = HKSampleQuery(
                sampleType: type,
                predicate: predicate,
                limit: 1,
                sortDescriptors: sortDescriptors
            ) { _, samples, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }

                let sample = samples?.first as? HKQuantitySample
                continuation.resume(returning: sample?.quantity.doubleValue(for: unit))
            }

            healthStore.execute(query)
        }
    }

    private func fetchSleepHoursIfAvailable(startDate: Date, endDate: Date) async -> Double? {
        guard let type = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) else {
            return nil
        }

        do {
            let samples: [HKCategorySample] = try await withCheckedThrowingContinuation { continuation in
                let query = HKSampleQuery(
                    sampleType: type,
                    predicate: Self.samplePredicate(startDate: startDate, endDate: endDate),
                    limit: HKObjectQueryNoLimit,
                    sortDescriptors: nil
                ) { _, samples, error in
                    if let error {
                        continuation.resume(throwing: error)
                        return
                    }

                    let categorySamples = (samples as? [HKCategorySample]) ?? []
                    continuation.resume(returning: categorySamples)
                }

                healthStore.execute(query)
            }

            let secondsAsleep = samples.reduce(0.0) { partialResult, sample in
                let isAsleep = sample.value == HKCategoryValueSleepAnalysis.asleep.rawValue ||
                    sample.value == HKCategoryValueSleepAnalysis.asleepCore.rawValue ||
                    sample.value == HKCategoryValueSleepAnalysis.asleepDeep.rawValue ||
                    sample.value == HKCategoryValueSleepAnalysis.asleepREM.rawValue ||
                    sample.value == HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue

                guard isAsleep else {
                    return partialResult
                }

                return partialResult + sample.endDate.timeIntervalSince(sample.startDate)
            }

            guard secondsAsleep > 0 else {
                return nil
            }

            return secondsAsleep / 3600
        } catch {
            return nil
        }
    }

    private func fetchWorkoutCount(startDate: Date, endDate: Date) async throws -> Int {
        try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(
                sampleType: HKObjectType.workoutType(),
                predicate: Self.samplePredicate(startDate: startDate, endDate: endDate),
                limit: HKObjectQueryNoLimit,
                sortDescriptors: nil
            ) { _, samples, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }

                continuation.resume(returning: samples?.count ?? 0)
            }

            healthStore.execute(query)
        }
    }

    private func fetchWorkoutCandidates(days: Int, reportProgress: Bool) async throws -> [WorkoutSyncCandidate] {
        let calendar = Calendar.current
        let startDate = calendar.date(byAdding: .day, value: -max(days - 1, 0), to: calendar.startOfDay(for: Date())) ?? Date()
        let workouts: [HKWorkout] = try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(
                sampleType: HKObjectType.workoutType(),
                predicate: Self.samplePredicate(startDate: startDate, endDate: Date()),
                limit: HKObjectQueryNoLimit,
                sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)]
            ) { _, samples, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }

                continuation.resume(returning: (samples as? [HKWorkout]) ?? [])
            }

            healthStore.execute(query)
        }

        var candidates: [WorkoutSyncCandidate] = []
        candidates.reserveCapacity(workouts.count)

        for (index, workout) in workouts.enumerated() {
            if reportProgress {
                workoutSyncProgress = "Preparing workout \(index + 1) of \(workouts.count)..."
            }
            candidates.append(try await buildWorkoutCandidate(from: workout))
        }

        return candidates
    }

    private func buildWorkoutCandidate(from workout: HKWorkout) async throws -> WorkoutSyncCandidate {
        let heartRateSummary = try await fetchHeartRateSummary(for: workout)
        let routePoints = try await fetchRoutePoints(for: workout)

        return WorkoutSyncCandidate(
            workoutID: workout.uuid.uuidString,
            date: Self.isoDateString(for: workout.startDate),
            source: "ios_healthkit_workout",
            activityType: workout.workoutActivityType.storageName,
            activityLabel: workout.workoutActivityType.displayName,
            startDate: Self.isoTimestampString(for: workout.startDate),
            endDate: Self.isoTimestampString(for: workout.endDate),
            durationMinutes: workout.duration / 60,
            totalDistanceKM: workout.totalDistance?.doubleValue(for: .meterUnit(with: .kilo)),
            activeEnergyKcal: workout.totalEnergyBurned?.doubleValue(for: .kilocalorie()),
            avgHeartRateBPM: heartRateSummary.avg,
            maxHeartRateBPM: heartRateSummary.max,
            sourceName: workout.sourceRevision.source.name,
            routePoints: routePoints
        )
    }

    private func fetchHeartRateSummary(for workout: HKWorkout) async throws -> (avg: Double?, max: Double?) {
        guard let heartRateType = HKObjectType.quantityType(forIdentifier: .heartRate) else {
            return (nil, nil)
        }

        return try await withCheckedThrowingContinuation { continuation in
            let query = HKStatisticsQuery(
                quantityType: heartRateType,
                quantitySamplePredicate: Self.samplePredicate(startDate: workout.startDate, endDate: workout.endDate),
                options: [.discreteAverage, .discreteMax]
            ) { _, statistics, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }

                let unit = HKUnit.count().unitDivided(by: .minute())
                continuation.resume(
                    returning: (
                        statistics?.averageQuantity()?.doubleValue(for: unit),
                        statistics?.maximumQuantity()?.doubleValue(for: unit)
                    )
                )
            }

            healthStore.execute(query)
        }
    }

    private func fetchRoutePoints(for workout: HKWorkout) async throws -> [WorkoutRoutePointSyncPayload] {
        let routes: [HKWorkoutRoute] = try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(
                sampleType: HKSeriesType.workoutRoute(),
                predicate: HKQuery.predicateForObjects(from: workout),
                limit: HKObjectQueryNoLimit,
                sortDescriptors: nil
            ) { _, samples, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }

                continuation.resume(returning: (samples as? [HKWorkoutRoute]) ?? [])
            }

            healthStore.execute(query)
        }

        var allPoints: [WorkoutRoutePointSyncPayload] = []
        for route in routes {
            allPoints.append(contentsOf: try await fetchLocations(for: route))
        }

        guard allPoints.count > 250 else {
            return allPoints
        }

        return allPoints.enumerated().compactMap { index, point in
            if index == 0 || index == allPoints.count - 1 || index % 8 == 0 {
                return point
            }
            return nil
        }
    }

    private func fetchLocations(for route: HKWorkoutRoute) async throws -> [WorkoutRoutePointSyncPayload] {
        try await withCheckedThrowingContinuation { continuation in
            var points: [WorkoutRoutePointSyncPayload] = []
            let query = HKWorkoutRouteQuery(route: route) { _, locationsOrNil, done, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }

                if let locations = locationsOrNil {
                    points.append(contentsOf: locations.map { location in
                        WorkoutRoutePointSyncPayload(
                            timestamp: Self.isoTimestampString(for: location.timestamp),
                            latitude: location.coordinate.latitude,
                            longitude: location.coordinate.longitude,
                            altitude_m: location.altitude,
                            horizontal_accuracy_m: location.horizontalAccuracy,
                            vertical_accuracy_m: location.verticalAccuracy
                        )
                    })
                }

                if done {
                    continuation.resume(returning: points)
                }
            }

            healthStore.execute(query)
        }
    }

    private func postSnapshotToJarvis(
        _ snapshot: TodayHealthSnapshot,
        candidateBaseURLs: [String]? = nil
    ) async throws -> String {
        let candidateBaseURLs = candidateBaseURLs ?? resolvedBaseURLsForSync()
        guard !candidateBaseURLs.isEmpty else {
            throw URLError(.badURL)
        }

        let payload = HealthSyncPayload(
            date: snapshot.date,
            source: "ios_healthkit",
            steps: Int(snapshot.steps),
            active_energy_kcal: snapshot.activeEnergy,
            sleep_hours: snapshot.sleepHours,
            workouts: snapshot.workouts,
            resting_heart_rate: snapshot.restingHeartRate,
            extra_metrics: snapshot.extraMetrics
        )
        let requestBody = try JSONEncoder().encode(payload)
        var lastError: Error = URLError(.cannotConnectToHost)
        var attemptedBaseURLs: [String] = []

        for baseURL in candidateBaseURLs {
            attemptedBaseURLs.append(baseURL)
            do {
                try await postSnapshot(requestBody: requestBody, baseURL: baseURL)
                return baseURL
            } catch {
                lastError = error
            }
        }

        let attemptedText = attemptedBaseURLs.joined(separator: ", ")
        throw NSError(
            domain: "JarvisHealthSync",
            code: 1,
            userInfo: [
                NSLocalizedDescriptionKey:
                    "\(lastError.localizedDescription) Attempted: \(attemptedText)"
            ]
        )
    }

    private func postSnapshot(requestBody: Data, baseURL: String) async throws {
        guard let url = URL(string: baseURL + "/health/daily") else {
            throw URLError(.badURL)
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 20
        request.httpBody = requestBody

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            throw NSError(
                domain: "JarvisHealthSync",
                code: httpResponse.statusCode,
                userInfo: [
                    NSLocalizedDescriptionKey:
                        buildServerErrorMessage(
                            statusCode: httpResponse.statusCode,
                            baseURL: baseURL,
                            responseData: data
                        )
                ]
            )
        }
    }

    private func postWorkoutsToJarvis(
        _ workouts: [WorkoutSyncCandidate],
        candidateBaseURLs: [String]? = nil
    ) async throws -> String {
        let payload = WorkoutBatchSyncPayload(
            workouts: workouts.map { workout in
                WorkoutSyncPayload(
                    workout_id: workout.workoutID,
                    date: workout.date,
                    source: workout.source,
                    activity_type: workout.activityType,
                    activity_label: workout.activityLabel,
                    start_date: workout.startDate,
                    end_date: workout.endDate,
                    duration_minutes: workout.durationMinutes,
                    total_distance_km: workout.totalDistanceKM,
                    active_energy_kcal: workout.activeEnergyKcal,
                    avg_heart_rate_bpm: workout.avgHeartRateBPM,
                    max_heart_rate_bpm: workout.maxHeartRateBPM,
                    source_name: workout.sourceName,
                    route_points: workout.routePoints
                )
            }
        )

        let requestBody = try JSONEncoder().encode(payload)
        let candidateBaseURLs = candidateBaseURLs ?? resolvedBaseURLsForSync()
        guard !candidateBaseURLs.isEmpty else {
            throw URLError(.badURL)
        }

        var lastError: Error = URLError(.cannotConnectToHost)
        for baseURL in candidateBaseURLs {
            do {
                try await postWorkoutBatch(requestBody: requestBody, baseURL: baseURL)
                return baseURL
            } catch {
                lastError = error
            }
        }

        throw lastError
    }

    private func postWorkoutBatch(requestBody: Data, baseURL: String) async throws {
        guard let url = URL(string: baseURL + "/workouts/sync") else {
            throw URLError(.badURL)
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 30
        request.httpBody = requestBody

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            throw NSError(
                domain: "JarvisWorkoutSync",
                code: httpResponse.statusCode,
                userInfo: [
                    NSLocalizedDescriptionKey:
                        buildServerErrorMessage(
                            statusCode: httpResponse.statusCode,
                            baseURL: baseURL,
                            responseData: data
                        )
                ]
            )
        }
    }

    private func buildServerErrorMessage(statusCode: Int, baseURL: String, responseData: Data) -> String {
        var message = "Jarvis returned status \(statusCode) from \(baseURL)."
        if let serverMessage = parseServerErrorMessage(from: responseData) {
            message += " \(serverMessage)"
        }
        return message
    }

    private func parseServerErrorMessage(from data: Data) -> String? {
        guard !data.isEmpty else {
            return nil
        }

        if
            let jsonObject = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let detail = jsonObject["detail"] as? String,
            !detail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            return detail.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        guard let rawText = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !rawText.isEmpty
        else {
            return nil
        }

        let collapsedText = rawText.replacingOccurrences(
            of: #"\s+"#,
            with: " ",
            options: .regularExpression
        )
        return String(collapsedText.prefix(220))
    }

    private func authorizationRequestStatus() async throws -> HKAuthorizationRequestStatus {
        try await withCheckedThrowingContinuation { continuation in
            healthStore.getRequestStatusForAuthorization(
                toShare: [],
                read: requestedObjectTypes
            ) { status, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }

                continuation.resume(returning: status)
            }
        }
    }

    private static var todayPredicate: NSPredicate {
        samplePredicate(
            startDate: Calendar.current.startOfDay(for: Date()),
            endDate: Date()
        )
    }

    private static func samplePredicate(startDate: Date, endDate: Date) -> NSPredicate {
        HKQuery.predicateForSamples(
            withStart: startDate,
            end: endDate,
            options: .strictStartDate
        )
    }

    private static func isoDateString(for date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    private static func isoTimestampString(for date: Date) -> String {
        ISO8601DateFormatter().string(from: date)
    }

    private static func miles(fromKilometers kilometers: Double) -> Double {
        kilometers * 0.621371
    }

    private func normalizedBaseURL(_ rawValue: String) -> String {
        rawValue.trimmingCharacters(in: CharacterSet(charactersIn: "/ \n\t"))
    }

    private func resolvedBaseURLsForSync() -> [String] {
        let normalized = normalizedBaseURL(selectedBaseURL)
        return normalized.isEmpty ? [] : [normalized]
    }

    private func snapshotHasMeaningfulData(_ snapshot: TodayHealthSnapshot) -> Bool {
        if snapshot.steps > 0 || snapshot.workouts > 0 {
            return true
        }
        if let activeEnergy = snapshot.activeEnergy, activeEnergy > 0 {
            return true
        }
        if let sleepHours = snapshot.sleepHours, sleepHours > 0 {
            return true
        }
        if snapshot.restingHeartRate != nil {
            return true
        }
        return snapshot.extraMetrics.contains { key, value in
            guard let value else { return false }
            if key == "steps" || key == "active_energy_kcal" || key == "resting_heart_rate_bpm" {
                return false
            }
            return value != 0
        }
    }

    private func shouldAutoSyncWorkouts(after snapshot: TodayHealthSnapshot) -> Bool {
        if snapshot.workouts > 0 {
            return true
        }

        guard let lastAutoWorkoutSyncAt else {
            return true
        }

        return Date().timeIntervalSince(lastAutoWorkoutSyncAt) >= AutoSync.workoutMinimumInterval
    }

    private func fetchOldestSampleDate() async throws -> Date? {
        var oldestDate: Date?

        for objectType in requestedObjectTypes {
            guard let sampleType = objectType as? HKSampleType else {
                continue
            }

            let candidate = try await fetchOldestSampleDate(for: sampleType)
            guard let candidate else {
                continue
            }

            if let currentOldestDate = oldestDate {
                if candidate < currentOldestDate {
                    oldestDate = candidate
                }
            } else {
                oldestDate = candidate
            }
        }

        return oldestDate
    }

    private func fetchOldestSampleDate(for sampleType: HKSampleType) async throws -> Date? {
        try await withCheckedThrowingContinuation { continuation in
            let sortDescriptors = [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)]
            let query = HKSampleQuery(
                sampleType: sampleType,
                predicate: nil,
                limit: 1,
                sortDescriptors: sortDescriptors
            ) { _, samples, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }

                continuation.resume(returning: samples?.first?.startDate)
            }

            healthStore.execute(query)
        }
    }
}

private extension HKWorkoutActivityType {
    var storageName: String {
        String(rawValue)
    }

    var displayName: String {
        switch self {
        case .climbing:
            return "Climbing"
        case .cycling:
            return "Cycling"
        case .elliptical:
            return "Elliptical"
        case .rowing:
            return "Rowing"
        case .running:
            return "Run"
        case .stairClimbing, .stairs, .stepTraining:
            return "Stairs"
        case .walking:
            return "Walk"
        case .hiking:
            return "Hike"
        case .swimming:
            return "Swim"
        case .traditionalStrengthTraining:
            return "Strength"
        case .functionalStrengthTraining:
            return "Functional Strength"
        case .coreTraining:
            return "Core Training"
        case .highIntensityIntervalTraining:
            return "HIIT"
        case .mixedCardio, .mixedMetabolicCardioTraining:
            return "Mixed Cardio"
        case .pilates:
            return "Pilates"
        case .pickleball:
            return "Pickleball"
        case .dance, .danceInspiredTraining, .cardioDance, .socialDance:
            return "Dance"
        case .cooldown:
            return "Cooldown"
        case .yoga:
            return "Yoga"
        default:
            return "Workout"
        }
    }
}
