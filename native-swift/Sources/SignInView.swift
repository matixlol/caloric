import SwiftUI

struct SignInView: View {
    @Environment(NativeAuth.self) private var auth
    @State private var method = 0
    @State private var email = ""
    @State private var password = ""
    @State private var name = ""
    @State private var code = ""
    @State private var codeSent = false
    @State private var creatingAccount = false
    @State private var busy = false
    @State private var error: String?
    private var normalizedEmail: String { email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
    private var validEmail: Bool { normalizedEmail.range(of: #"^[^\s@]+@[^\s@]+\.[^\s@]+$"#, options: .regularExpression) != nil }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("Caloric").screenTitle()
                Text("Sign in or create an account to continue.").font(.system(size: 16)).foregroundStyle(.secondary)
                Picker("Sign-in method", selection: $method) {
                    Text("Email code").tag(0)
                    Text("Password").tag(1)
                }.pickerStyle(.segmented).disabled(busy)
                VStack(alignment: .leading, spacing: 6) {
                    Text("Email").font(.subheadline)
                    TextField("you@example.com", text: $email).keyboardType(.emailAddress).textContentType(.emailAddress)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("login-email")
                        .padding(12).background(Theme.background, in: RoundedRectangle(cornerRadius: 10))
                }
                if method == 0 {
                    if codeSent {
                        Text("We sent a 6-digit code to \(normalizedEmail).").font(.subheadline).foregroundStyle(.secondary)
                        TextField("Verification code", text: $code).keyboardType(.numberPad).textContentType(.oneTimeCode)
                            .accessibilityIdentifier("login-code").padding(12).background(Theme.background, in: RoundedRectangle(cornerRadius: 10))
                            .onChange(of: code) { _, value in code = String(value.filter(\.isNumber).prefix(6)) }
                        primaryButton("Verify code", enabled: code.count == 6 && validEmail) {
                            try await auth.signIn(email: normalizedEmail, code: code)
                        }
                        Button("Resend code") { run { try await auth.sendCode(email: normalizedEmail) } }.disabled(busy || !validEmail)
                        Button("Use a different email") { codeSent = false; code = ""; error = nil }.disabled(busy)
                    } else {
                        primaryButton("Send code", enabled: validEmail) {
                            try await auth.sendCode(email: normalizedEmail)
                            codeSent = true
                        }
                    }
                } else {
                    if creatingAccount {
                        TextField("Name", text: $name).textContentType(.name).accessibilityIdentifier("login-name")
                            .padding(12).background(Theme.background, in: RoundedRectangle(cornerRadius: 10))
                    }
                    SecureField("Password", text: $password).textContentType(creatingAccount ? .newPassword : .password)
                        .accessibilityIdentifier("login-password").padding(12).background(Theme.background, in: RoundedRectangle(cornerRadius: 10))
                    primaryButton(creatingAccount ? "Create account" : "Sign in", enabled: validEmail && password.count >= 8 && (!creatingAccount || !name.trimmingCharacters(in: .whitespaces).isEmpty)) {
                        if creatingAccount { try await auth.signUp(email: normalizedEmail, password: password, name: name.trimmingCharacters(in: .whitespaces)) }
                        else { try await auth.signIn(email: normalizedEmail, password: password) }
                    }
                    Button(creatingAccount ? "Have an account? Sign in" : "New here? Create an account") { creatingAccount.toggle(); error = nil }.disabled(busy)
                }
                if let error = error ?? auth.error { Text(error).font(.subheadline).foregroundStyle(.red) }
            }.disabled(busy).padding(24).background(Theme.card, in: RoundedRectangle(cornerRadius: 16)).padding(20)
        }.defaultScrollAnchor(.center).scrollDismissesKeyboard(.interactively)
            .onChange(of: method) { _, _ in codeSent = false; code = ""; error = nil }
    }
    private func primaryButton(_ title: String, enabled: Bool, action: @escaping @MainActor () async throws -> Void) -> some View {
        Button { run(action) } label: {
            HStack { Spacer(); if busy { ProgressView().tint(.white) } else { Text(title).fontWeight(.semibold) }; Spacer() }.padding(.vertical, 14)
        }.buttonStyle(.plain).foregroundStyle(.white).background(Theme.tint, in: RoundedRectangle(cornerRadius: 10))
            .disabled(busy || !enabled).opacity(busy || !enabled ? 0.5 : 1)
    }
    private func run(_ action: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true
        error = nil
        Task { @MainActor in
            defer { busy = false }
            do { try await action() }
            catch { self.error = error.localizedDescription }
        }
    }
}
