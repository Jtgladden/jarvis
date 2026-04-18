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

    @Published var isHealthDataAvailable = HKHealthStore.isHealthDataAvailable()
    @Published var isRequestInFlight = false
    @Published var isSyncInFlight = false
    @Published var hasRequestedAuthorization = false
    @Published var errorMessage: String?
    @Published var todaySummary: String?
    @Published var syncMessage: String?
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

    func updateServerMode(_ mode: JarvisServerMode) {
        serverMode = mode
        userDefaults.set(mode.rawValue, forKey: StorageKeys.serverMode)
    }

    func updateLocalBaseURL(_ value: String) {
        localBaseURL = value
        userDefaults.set(value, forKey: StorageKeys.localBaseURL)
    }

    func updateCustomBaseURL(_ value: String) {
        customBaseURL = value
        userDefaults.set(value, forKey: StorageKeys.customBaseURL)
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
            try await postSnapshotToJarvis(snapshot)
            todaySummary = buildSummaryText(from: snapshot)
            syncMessage = "Synced today's expanded Apple Health metrics to Jarvis."
        } catch {
            errorMessage = "Jarvis sync failed: \(error.localizedDescription)"
        }

        isSyncInFlight = false
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

        return objectTypes
    }

    private func fetchTodaySnapshot() async throws -> TodayHealthSnapshot {
        async let metricMap = fetchRequestedMetrics()
        async let sleepHours = fetchSleepHoursIfAvailable()
        async let workouts = fetchTodayWorkoutCount()

        let resolvedMetricMap = try await metricMap
        let resolvedSleepHours = await sleepHours
        let resolvedWorkouts = try await workouts
        let resolvedSteps = (resolvedMetricMap["steps"] ?? nil) ?? 0

        return TodayHealthSnapshot(
            date: Self.isoDateString(for: Date()),
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

    private func fetchRequestedMetrics() async throws -> [String: Double?] {
        var results: [String: Double?] = [:]

        for metric in quantityMetrics {
            switch metric {
            case .cumulative(let identifier, let unit, let key):
                results[key] = await fetchQuantityMetricIfAvailable(
                    identifier: identifier,
                    unit: unit,
                    mode: .cumulative
                )
            case .average(let identifier, let unit, let key):
                results[key] = await fetchQuantityMetricIfAvailable(
                    identifier: identifier,
                    unit: unit,
                    mode: .average
                )
            case .latest(let identifier, let unit, let key):
                results[key] = await fetchQuantityMetricIfAvailable(
                    identifier: identifier,
                    unit: unit,
                    mode: .latest
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
        mode: QuantityFetchMode
    ) async -> Double? {
        do {
            switch mode {
            case .cumulative:
                return try await fetchCumulativeQuantity(identifier: identifier, unit: unit)
            case .average:
                return try await fetchAverageQuantity(identifier: identifier, unit: unit)
            case .latest:
                return try await fetchLatestQuantity(identifier: identifier, unit: unit)
            }
        } catch {
            return nil
        }
    }

    private func fetchCumulativeQuantity(
        identifier: HKQuantityTypeIdentifier,
        unit: HKUnit
    ) async throws -> Double? {
        guard let type = HKObjectType.quantityType(forIdentifier: identifier) else {
            return nil
        }

        let quantity: HKQuantity? = try await withCheckedThrowingContinuation { continuation in
            let query = HKStatisticsQuery(
                quantityType: type,
                quantitySamplePredicate: Self.todayPredicate,
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
        unit: HKUnit
    ) async throws -> Double? {
        guard let type = HKObjectType.quantityType(forIdentifier: identifier) else {
            return nil
        }

        let quantity: HKQuantity? = try await withCheckedThrowingContinuation { continuation in
            let query = HKStatisticsQuery(
                quantityType: type,
                quantitySamplePredicate: Self.todayPredicate,
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
        unit: HKUnit
    ) async throws -> Double? {
        guard let type = HKObjectType.quantityType(forIdentifier: identifier) else {
            return nil
        }

        return try await withCheckedThrowingContinuation { continuation in
            let sortDescriptors = [NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)]
            let query = HKSampleQuery(
                sampleType: type,
                predicate: nil,
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

    private func fetchSleepHoursIfAvailable() async -> Double? {
        guard let type = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) else {
            return nil
        }

        do {
            let samples: [HKCategorySample] = try await withCheckedThrowingContinuation { continuation in
                let query = HKSampleQuery(
                    sampleType: type,
                    predicate: Self.todayPredicate,
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

    private func fetchTodayWorkoutCount() async throws -> Int {
        try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(
                sampleType: HKObjectType.workoutType(),
                predicate: Self.todayPredicate,
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

    private func postSnapshotToJarvis(_ snapshot: TodayHealthSnapshot) async throws {
        let candidateBaseURLs = resolvedBaseURLsForSync()
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

        for baseURL in candidateBaseURLs {
            do {
                try await postSnapshot(requestBody: requestBody, baseURL: baseURL)
                return
            } catch {
                lastError = error
            }
        }

        throw lastError
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

        let (_, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            throw NSError(
                domain: "JarvisHealthSync",
                code: httpResponse.statusCode,
                userInfo: [
                    NSLocalizedDescriptionKey:
                        "Jarvis returned status \(httpResponse.statusCode) from \(baseURL)."
                ]
            )
        }
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
        HKQuery.predicateForSamples(
            withStart: Calendar.current.startOfDay(for: Date()),
            end: Date(),
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

    private func resolvedBaseURLsForSync() -> [String] {
        let primary = selectedBaseURL
        let fallback = serverMode == .production ? normalizedBaseURL(localBaseURL) : productionBaseURL
        var orderedURLs: [String] = []

        for value in [primary, fallback] {
            let normalized = normalizedBaseURL(value)
            guard !normalized.isEmpty, !orderedURLs.contains(normalized) else {
                continue
            }
            orderedURLs.append(normalized)
        }

        return orderedURLs
    }

    private func normalizedBaseURL(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }
}
