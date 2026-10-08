import SwiftUI
import AVFoundation

struct BarcodeScanner: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
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
                CameraPreview(isActive: scenePhase == .active, scanned: accept, failed: { cameraError = $0 })
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
    let isActive: Bool
    let scanned: (String) -> Void
    let failed: (String) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(scanned: scanned, failed: failed) }
    func makeUIView(context: Context) -> CameraSurface {
        let view = CameraSurface()
        view.preview.videoGravity = .resizeAspectFill
        view.preview.session = context.coordinator.session
        return view
    }
    func updateUIView(_ view: CameraSurface, context: Context) { context.coordinator.setActive(isActive) }
    static func dismantleUIView(_ view: CameraSurface, coordinator: Coordinator) { coordinator.stop() }
    final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        let session = AVCaptureSession()
        private let queue = DispatchQueue(label: "caloric.barcode.camera")
        private let scanned: (String) -> Void
        private let failed: (String) -> Void
        private var device: AVCaptureDevice?
        private var active = false
        private var captured = false
        init(scanned: @escaping (String) -> Void, failed: @escaping (String) -> Void) { self.scanned = scanned; self.failed = failed }
        func setActive(_ active: Bool) {
            queue.async { [self] in
                guard active != self.active else { return }
                self.active = active
                guard active, !captured else { stopCamera(); return }
                do {
                    if device == nil { try configureSession() }
                    guard let device else { throw CameraFailure.unavailable }
                    try configureOptics(device)
                    session.startRunning()
                    // Torch availability is established once the session is running.
                    setTorch(.auto)
                } catch {
                    stopCamera()
                    DispatchQueue.main.async { self.failed("Camera unavailable. Enter the barcode number below.") }
                }
            }
        }
        private func configureSession() throws {
            // Use the rear main lens so 2× consistently means twice the normal
            // framing, rather than twice an ultra-wide virtual-camera baseline.
            guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else { throw CameraFailure.unavailable }
            let input = try AVCaptureDeviceInput(device: device)
            let output = AVCaptureMetadataOutput()
            session.beginConfiguration()
            defer { session.commitConfiguration() }
            guard session.canAddInput(input), session.canAddOutput(output) else { throw CameraFailure.unavailable }
            session.addInput(input); session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: queue)
            output.metadataObjectTypes = [.ean8, .ean13].filter { output.availableMetadataObjectTypes.contains($0) }
            self.device = device
        }
        private func configureOptics(_ device: AVCaptureDevice) throws {
            try device.lockForConfiguration()
            defer { device.unlockForConfiguration() }
            device.videoZoomFactor = min(device.maxAvailableVideoZoomFactor, max(device.minAvailableVideoZoomFactor, 2))
            let center = CGPoint(x: 0.5, y: 0.5)
            if device.isFocusPointOfInterestSupported { device.focusPointOfInterest = center }
            if device.isFocusModeSupported(.continuousAutoFocus) { device.focusMode = .continuousAutoFocus }
            if device.isExposurePointOfInterestSupported { device.exposurePointOfInterest = center }
            if device.isExposureModeSupported(.continuousAutoExposure) { device.exposureMode = .continuousAutoExposure }
        }
        private func setTorch(_ mode: AVCaptureDevice.TorchMode) {
            guard let device, device.hasTorch, device.isTorchModeSupported(mode) else { return }
            // A temporarily unavailable/thermal-limited torch must not prevent scanning.
            do {
                try device.lockForConfiguration()
                defer { device.unlockForConfiguration() }
                device.torchMode = mode
            } catch { }
        }
        private func stopCamera() {
            setTorch(.off)
            if session.isRunning { session.stopRunning() }
        }
        func stop() { setActive(false) }
        func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
            guard active, !captured, let code = objects.compactMap({ ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }).first,
                  BarcodeScanner.normalize(code) != nil else { return }
            captured = true; active = false
            // Finish the metadata callback before synchronously stopping capture.
            queue.async { [self] in
                stopCamera()
                DispatchQueue.main.async { self.scanned(code) }
            }
        }
    }
    enum CameraFailure: Error { case unavailable }
}
