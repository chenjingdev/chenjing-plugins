import Security

/// Whether this process is the app CUA Bar's developer ships: signed by the team's Developer ID as an installed app is,
/// not a local build signed ad hoc. The system answers, from the signature of the running process itself.
enum OfficialBuild {
    static func runningProcessIsOfficial() -> Bool {
        runningProcessSatisfies(UpdateSource.appRequirement)
    }

    /// `SecCodeCheckValidity` of this process against a requirement written in the code requirement language. False
    /// for a requirement that does not parse, and for a process with no signature at all.
    static func runningProcessSatisfies(_ requirement: String) -> Bool {
        var code: SecCode?
        guard SecCodeCopySelf(SecCSFlags(), &code) == errSecSuccess, let code else { return false }
        var parsed: SecRequirement?
        guard SecRequirementCreateWithString(requirement as CFString, SecCSFlags(), &parsed) == errSecSuccess, let parsed else {
            return false
        }
        return SecCodeCheckValidity(code, SecCSFlags(), parsed) == errSecSuccess
    }
}
