import SwiftUI
import AVFoundation

struct BarcodeScanner: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    let scanned: (String) -> Void
    @State private var allowed = AVCaptureDevice.authorizationStatus(for: .video) == .authorized
    @State private var code = ""
    @State private var cameraError: String?
    @State private var completed = false
    static func normalize(_ code: String) -> String? {
        var digits = code.filter(\.isNumber)
        if digits.count == 12 { digits = "0" + digits }
        guard [8, 13].contains(digits.count), digits.allSatisfy({ $0.isASCII }) else { return nil }
        return digits
    }
    var body: some View {
        VStack(spacing: 16) {
            HStack {
                Text("Scan barcode").screenTitle()
                Button("Done") { dismiss() }
            }
            if allowed && !AppConfiguration.uiTesting && cameraError == nil {
                CameraPreview(scanned: accept, failed: { cameraError = $0 })
                    .overlay(RoundedRectangle(cornerRadius: 16).stroke(.white.opacity(0.85), lineWidth: 2).padding(35).allowsHitTesting(false))
                    .frame(minHeight: 220, maxHeight: 350).clipShape(RoundedRectangle(cornerRadius: 18))
            } else {
                VStack(spacing: 12) {
                    Image(systemName: "barcode.viewfinder").font(.system(size: 50)).foregroundStyle(Theme.tint)
                    if let cameraError { Text(cameraError).font(.subheadline).foregroundStyle(.secondary) }
                    if !allowed {
                        Text("Camera access is needed to scan food packaging.").foregroundStyle(.secondary)
                        Button("Allow camera") { Task {
                            switch AVCaptureDevice.authorizationStatus(for: .video) {
                            case .notDetermined: allowed = await AVCaptureDevice.requestAccess(for: .video)
                            case .authorized: allowed = true
                            default: openURL(URL(string: UIApplication.openSettingsURLString)!)
                            }
                        } }
                    }
                }.frame(maxWidth: .infinity).padding(32).caloricCard()
            }
            TextField("Barcode number", text: $code).keyboardType(.numberPad).textInputAutocapitalization(.never)
                .padding(14).background(Theme.card, in: RoundedRectangle(cornerRadius: 12)).accessibilityIdentifier("barcode-number")
            PrimaryButton(title: "Look up barcode", enabled: Self.normalize(code) != nil) { accept(code) }
            Spacer()
        }.padding(16).background(Theme.background)
    }
    private func accept(_ code: String) {
        guard !completed, let value = Self.normalize(code) else { return }
        completed = true
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        scanned(value); dismiss()
    }
}

private final class CameraSurface: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var preview: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
}

private struct CameraPreview: UIViewRepresentable {
    let scanned: (String) -> Void
    let failed: (String) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(scanned: scanned, failed: failed) }
    func makeUIView(context: Context) -> CameraSurface {
        let view = CameraSurface()
        view.preview.videoGravity = .resizeAspectFill
        view.preview.session = context.coordinator.session
        context.coordinator.start()
        return view
    }
    func updateUIView(_ view: CameraSurface, context: Context) {}
    static func dismantleUIView(_ view: CameraSurface, coordinator: Coordinator) { coordinator.stop() }
    final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        let session = AVCaptureSession()
        private let queue = DispatchQueue(label: "caloric.barcode.camera")
        private let scanned: (String) -> Void
        private let failed: (String) -> Void
        private var captured = false
        init(scanned: @escaping (String) -> Void, failed: @escaping (String) -> Void) { self.scanned = scanned; self.failed = failed }
        func start() {
            queue.async { [self] in
                do {
                    guard let device = AVCaptureDevice.default(for: .video) else { throw CameraFailure.unavailable }
                    let input = try AVCaptureDeviceInput(device: device)
                    let output = AVCaptureMetadataOutput()
                    session.beginConfiguration()
                    guard session.canAddInput(input), session.canAddOutput(output) else { session.commitConfiguration(); throw CameraFailure.unavailable }
                    session.addInput(input); session.addOutput(output)
                    output.setMetadataObjectsDelegate(self, queue: .main)
                    output.metadataObjectTypes = [.ean8, .ean13].filter { output.availableMetadataObjectTypes.contains($0) }
                    session.commitConfiguration(); session.startRunning()
                } catch { DispatchQueue.main.async { self.failed("Camera unavailable. Enter the barcode number below.") } }
            }
        }
        func stop() { queue.async { [self] in if session.isRunning { session.stopRunning() } } }
        func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
            guard !captured, let code = objects.compactMap({ ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }).first,
                  BarcodeScanner.normalize(code) != nil else { return }
            captured = true; stop(); scanned(code)
        }
    }
    enum CameraFailure: Error { case unavailable }
}
