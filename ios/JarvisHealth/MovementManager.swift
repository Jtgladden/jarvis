import CoreLocation
import Foundation
import SwiftUI

struct MovementVisitPayload: Codable {
    let arrival: String?
    let departure: String?
    let latitude: Double
    let longitude: Double
    let horizontal_accuracy_m: Double?
    let label: String?
}

struct MovementRoutePointPayload: Codable {
    let timestamp: String
    let latitude: Double
    let longitude: Double
    let horizontal_accuracy_m: Double?
}

struct MovementDailySyncPayload: Encodable {
    let date: String
    let source: String
    let total_distance_km: Double
    let time_away_minutes: Int?
    let visited_places_count: Int
    let movement_story: String
    let home_label: String?
    let commute_start: String?
    let commute_end: String?
    let visits: [MovementVisitPayload]
    let route_points: [MovementRoutePointPayload]
    let place_labels: [String]
}

struct LocalMovementVisit: Codable {
    let arrival: String?
    let departure: String?
    let latitude: Double
    let longitude: Double
    let horizontalAccuracyMeters: Double?
    let label: String?
}

struct LocalMovementRoutePoint: Codable {
    let timestamp: String
    let latitude: Double
    let longitude: Double
    let horizontalAccuracyMeters: Double?
}

struct LocalMovementDayJournal: Codable {
    let date: String
    var totalDistanceMeters: Double
    var visits: [LocalMovementVisit]
    var routePoints: [LocalMovementRoutePoint]
    var timeAwayMinutes: Int?
    var movementStory: String
}

@MainActor
final class MovementManager: NSObject, ObservableObject {
    private enum StorageKeys {
        static let movementJournal = "jarvis_movement_journal"
        static let movementSyncBaseURL = "jarvis_movement_sync_base_url"
    }

    @Published var authorizationStatus: CLAuthorizationStatus
    @Published var isTracking = false
    @Published var syncMessage: String?
    @Published var errorMessage: String?
    @Published var todaySummary: String?

    private let locationManager = CLLocationManager()
    private let userDefaults: UserDefaults
    private var lastRecordedLocation: CLLocation?
    private var syncTask: Task<Void, Never>?
    private var lastSyncAttemptAt: Date?
    private var configuredBaseURL: String?

    init(userDefaults: UserDefaults = .standard) {
        self.userDefaults = userDefaults
        self.authorizationStatus = locationManager.authorizationStatus
        self.configuredBaseURL = userDefaults.string(forKey: StorageKeys.movementSyncBaseURL)
        super.init()
        locationManager.delegate = self
        locationManager.activityType = .fitness
        locationManager.pausesLocationUpdatesAutomatically = true
        locationManager.allowsBackgroundLocationUpdates = true
        refreshSummary()
        resumeAutomaticTrackingIfAuthorized()
    }

    var authorizationMessage: String {
        switch authorizationStatus {
        case .authorizedAlways:
            return "Location access is allowed in the background for movement journaling."
        case .authorizedWhenInUse:
            return "Location access is limited to when the app is open. Background movement capture will be incomplete."
        case .notDetermined:
            return "Location access has not been requested yet."
        case .denied, .restricted:
            return "Location access is unavailable. Enable Always access in Settings for day-long movement tracking."
        @unknown default:
            return "Location authorization state is unknown."
        }
    }

    func requestAuthorization() {
        errorMessage = nil
        syncMessage = nil
        locationManager.requestAlwaysAuthorization()
    }

    func configureSync(baseURL: String) {
        let normalized = normalizedBaseURL(baseURL)
        configuredBaseURL = normalized
        userDefaults.set(normalized, forKey: StorageKeys.movementSyncBaseURL)
        scheduleAutomaticSync(reason: "server updated")
    }

    func handleAppBecameActive() {
        resumeAutomaticTrackingIfAuthorized()
        scheduleAutomaticSync(reason: "app active")
    }

    func startTracking() {
        guard authorizationStatus == .authorizedAlways || authorizationStatus == .authorizedWhenInUse else {
            errorMessage = "Grant location access before starting movement tracking."
            return
        }

        isTracking = true
        errorMessage = nil
        syncMessage = "Movement monitoring started."
        locationManager.startMonitoringVisits()
        locationManager.startMonitoringSignificantLocationChanges()
        locationManager.startUpdatingLocation()
    }

    func stopTracking() {
        isTracking = false
        locationManager.stopMonitoringVisits()
        locationManager.stopMonitoringSignificantLocationChanges()
        locationManager.stopUpdatingLocation()
        syncMessage = "Movement monitoring stopped."
    }

    func syncTodayToJarvis(baseURL: String) async {
        errorMessage = nil
        syncMessage = nil
        configureSync(baseURL: baseURL)

        do {
            let journal = loadTodayJournal()
            let payload = buildSyncPayload(from: journal)
            try await postMovementPayload(payload, baseURL: baseURL)
            lastSyncAttemptAt = Date()
            syncMessage = "Synced movement journal via \(baseURL)."
            refreshSummary()
        } catch {
            errorMessage = "Movement sync failed: \(error.localizedDescription)"
        }
    }

    func refreshSummary() {
        let journal = loadTodayJournal()
        todaySummary = buildSummaryText(from: journal)
    }

    private func buildSummaryText(from journal: LocalMovementDayJournal) -> String {
        let distanceKm = journal.totalDistanceMeters / 1000
        let awayText = journal.timeAwayMinutes.map { "\($0) minutes away from home" } ?? "home time not set yet"
        return String(
            format: "Today: %.1f km traveled, %d visits, %@.",
            distanceKm,
            journal.visits.count,
            awayText
        )
    }

    private func buildSyncPayload(from journal: LocalMovementDayJournal) -> MovementDailySyncPayload {
        let labels = Array(Set(journal.visits.compactMap(\.label))).sorted()
        let commuteStart = journal.visits.first?.departure
        let commuteEnd = journal.visits.last?.arrival

        return MovementDailySyncPayload(
            date: journal.date,
            source: "ios_core_location",
            total_distance_km: journal.totalDistanceMeters / 1000,
            time_away_minutes: journal.timeAwayMinutes,
            visited_places_count: journal.visits.count,
            movement_story: journal.movementStory,
            home_label: nil,
            commute_start: commuteStart,
            commute_end: commuteEnd,
            visits: journal.visits.map {
                MovementVisitPayload(
                    arrival: $0.arrival,
                    departure: $0.departure,
                    latitude: $0.latitude,
                    longitude: $0.longitude,
                    horizontal_accuracy_m: $0.horizontalAccuracyMeters,
                    label: $0.label
                )
            },
            route_points: simplifiedRoutePoints(journal.routePoints).map {
                MovementRoutePointPayload(
                    timestamp: $0.timestamp,
                    latitude: $0.latitude,
                    longitude: $0.longitude,
                    horizontal_accuracy_m: $0.horizontalAccuracyMeters
                )
            },
            place_labels: labels
        )
    }

    private func postMovementPayload(_ payload: MovementDailySyncPayload, baseURL: String) async throws {
        guard let url = URL(string: baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/movement/daily") else {
            throw URLError(.badURL)
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 20
        request.httpBody = try JSONEncoder().encode(payload)

        let (_, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            throw NSError(
                domain: "JarvisMovementSync",
                code: httpResponse.statusCode,
                userInfo: [NSLocalizedDescriptionKey: "Jarvis returned status \(httpResponse.statusCode)."]
            )
        }
    }

    private func loadTodayJournal() -> LocalMovementDayJournal {
        let today = Self.isoDateString(for: Date())
        let journals = loadAllJournals()
        return journals[today] ?? LocalMovementDayJournal(
            date: today,
            totalDistanceMeters: 0,
            visits: [],
            routePoints: [],
            timeAwayMinutes: nil,
            movementStory: "No movement summary yet."
        )
    }

    private func saveTodayJournal(_ journal: LocalMovementDayJournal) {
        var journals = loadAllJournals()
        journals[journal.date] = journal
        if let data = try? JSONEncoder().encode(journals) {
            userDefaults.set(data, forKey: StorageKeys.movementJournal)
        }
    }

    private func loadAllJournals() -> [String: LocalMovementDayJournal] {
        guard
            let data = userDefaults.data(forKey: StorageKeys.movementJournal),
            let decoded = try? JSONDecoder().decode([String: LocalMovementDayJournal].self, from: data)
        else {
            return [:]
        }
        return decoded
    }

    private func updateTodayJournal(_ update: (inout LocalMovementDayJournal) -> Void) {
        var journal = loadTodayJournal()
        update(&journal)
        journal.movementStory = generateMovementStory(for: journal)
        saveTodayJournal(journal)
        refreshSummary()
    }

    private func generateMovementStory(for journal: LocalMovementDayJournal) -> String {
        let distanceKm = journal.totalDistanceMeters / 1000
        if journal.visits.isEmpty && journal.routePoints.isEmpty {
            return "No visits recorded yet today."
        }

        if let firstArrival = journal.visits.first?.arrival, let lastDeparture = journal.visits.last?.departure {
            return String(
                format: "You traveled about %.1f km today, recorded %d visits, and moved between %@ and %@.",
                distanceKm,
                journal.visits.count,
                firstArrival,
                lastDeparture
            )
        }

        return String(
            format: "You traveled about %.1f km today and recorded %d visit events.",
            distanceKm,
            journal.visits.count
        )
    }

    private func simplifiedRoutePoints(_ points: [LocalMovementRoutePoint]) -> [LocalMovementRoutePoint] {
        guard points.count > 20 else {
            return points
        }

        return points.enumerated().compactMap { index, point in
            if index == 0 || index == points.count - 1 || index % 5 == 0 {
                return point
            }
            return nil
        }
    }

    private func resumeAutomaticTrackingIfAuthorized() {
        guard authorizationStatus == .authorizedAlways || authorizationStatus == .authorizedWhenInUse else {
            return
        }

        if !isTracking {
            startTracking()
        }
    }

    private func scheduleAutomaticSync(reason: String) {
        guard let baseURL = configuredBaseURL, !baseURL.isEmpty else {
            return
        }

        if let lastSyncAttemptAt, Date().timeIntervalSince(lastSyncAttemptAt) < 120 {
            return
        }

        syncTask?.cancel()
        syncTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(8))

            guard !Task.isCancelled else {
                return
            }

            await performAutomaticSync(baseURL: baseURL, reason: reason)
        }
    }

    private func performAutomaticSync(baseURL: String, reason: String) async {
        lastSyncAttemptAt = Date()

        do {
            let journal = loadTodayJournal()
            let payload = buildSyncPayload(from: journal)
            try await postMovementPayload(payload, baseURL: baseURL)
            syncMessage = "Auto-synced movement journal (\(reason))."
            errorMessage = nil
        } catch {
            errorMessage = "Automatic movement sync failed: \(error.localizedDescription)"
        }
    }

    private func normalizedBaseURL(_ rawValue: String) -> String {
        rawValue.trimmingCharacters(in: CharacterSet(charactersIn: "/ \n\t"))
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
}

extension MovementManager: CLLocationManagerDelegate {
    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in
            self.authorizationStatus = manager.authorizationStatus
            self.resumeAutomaticTrackingIfAuthorized()
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
        Task { @MainActor in
            self.updateTodayJournal { journal in
                journal.visits.append(
                    LocalMovementVisit(
                        arrival: visit.arrivalDate == .distantPast ? nil : Self.isoTimestampString(for: visit.arrivalDate),
                        departure: visit.departureDate == .distantFuture ? nil : Self.isoTimestampString(for: visit.departureDate),
                        latitude: visit.coordinate.latitude,
                        longitude: visit.coordinate.longitude,
                        horizontalAccuracyMeters: visit.horizontalAccuracy,
                        label: nil
                    )
                )
            }

            self.scheduleAutomaticSync(reason: "visit recorded")
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        Task { @MainActor in
            self.updateTodayJournal { journal in
                for location in locations {
                    if let previous = self.lastRecordedLocation {
                        journal.totalDistanceMeters += location.distance(from: previous)
                    }

                    self.lastRecordedLocation = location
                    journal.routePoints.append(
                        LocalMovementRoutePoint(
                            timestamp: Self.isoTimestampString(for: location.timestamp),
                            latitude: location.coordinate.latitude,
                            longitude: location.coordinate.longitude,
                            horizontalAccuracyMeters: location.horizontalAccuracy
                        )
                    )
                }
            }

            self.scheduleAutomaticSync(reason: "location updated")
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in
            self.errorMessage = "Location error: \(error.localizedDescription)"
        }
    }
}
