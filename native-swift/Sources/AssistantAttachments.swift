import ImageIO
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// A photo prepared for the assistant: an upload-ready JPEG plus a small preview for the chat.
struct AssistantImage: Identifiable {
    let id = UUID()
    let jpeg: Data
    let preview: UIImage
    var aspectRatio: CGFloat { preview.size.height > 0 ? preview.size.width / preview.size.height : 1 }
    init(jpeg: Data, preview: UIImage? = nil) {
        self.jpeg = jpeg
        self.preview = preview ?? AssistantImageProcessor.thumbnail(jpeg) ?? UIImage()
    }
}

enum AssistantImageProcessor {
    static let maxAttachments = 4
    static let maxPixelSize: CGFloat = 1600
    static let maxBytes = 8 * 1024 * 1024

    /// Downscales any decodable image (HEIC, PNG, JPEG…) to 1600 px on the long edge and re-encodes it as JPEG.
    static func prepare(_ data: Data) -> AssistantImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = thumbnail(source, maxPixelSize: maxPixelSize) else { return nil }
        return encode(UIImage(cgImage: image))
    }

    /// Camera and pasteboard images arrive as UIImage; render them upright at the upload size.
    static func prepare(_ image: UIImage) -> AssistantImage? {
        let longest = max(image.size.width, image.size.height)
        guard longest > 0 else { return nil }
        let scale = min(1, maxPixelSize / longest)
        let size = CGSize(width: (image.size.width * scale).rounded(), height: (image.size.height * scale).rounded())
        let format = UIGraphicsImageRendererFormat.default(); format.scale = 1; format.opaque = true
        let rendered = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        return encode(rendered)
    }

    static func thumbnail(_ data: Data, maxPixelSize: CGFloat = 480) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil), let image = thumbnail(source, maxPixelSize: maxPixelSize) else { return nil }
        return UIImage(cgImage: image)
    }

    private static func thumbnail(_ source: CGImageSource, maxPixelSize: CGFloat) -> CGImage? {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }

    private static func encode(_ image: UIImage) -> AssistantImage? {
        for quality in [0.8, 0.6, 0.4] {
            if let jpeg = image.jpegData(compressionQuality: quality), jpeg.count <= maxBytes {
                return AssistantImage(jpeg: jpeg, preview: thumbnail(jpeg))
            }
        }
        return nil
    }
}

/// Accepts only image drops (Photos, Files, Safari, other apps in Split View).
struct DroppedImage: Transferable {
    let data: Data
    static var transferRepresentation: some TransferRepresentation {
        DataRepresentation(importedContentType: .image) { DroppedImage(data: $0) }
    }
}

/// Minimal UIKit camera wrapper for "Take Photo".
struct CameraPicker: UIViewControllerRepresentable {
    let captured: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss
    static var isAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }
    func updateUIViewController(_ controller: UIImagePickerController, context: Context) { }
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage { parent.captured(image) }
            parent.dismiss()
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
    }
}

/// Pending photos shown above the composer, each removable.
struct AttachmentStrip: View {
    let images: [AssistantImage]
    let loading: Int
    let remove: (AssistantImage) -> Void
    let open: (Int) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        HStack(spacing: 10) {
            HStack(spacing: 10) {
                ForEach(Array(images.enumerated()), id: \.element.id) { index, image in
                    Button { open(index) } label: {
                        Image(uiImage: image.preview).resizable().scaledToFill()
                            .frame(width: 64, height: 64).clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(.white.opacity(0.25), lineWidth: 0.5))
                    }.buttonStyle(.plain)
                    .accessibilityLabel("Attached photo \(index + 1) of \(images.count)")
                    .accessibilityIdentifier("ai-attachment-thumbnail")
                    .overlay(alignment: .topTrailing) {
                        Button { remove(image) } label: {
                            Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).foregroundStyle(.white)
                                .frame(width: 22, height: 22).background(.black.opacity(0.62), in: Circle())
                                .overlay(Circle().strokeBorder(.white.opacity(0.85), lineWidth: 1.5))
                                .frame(width: 34, height: 34).contentShape(Rectangle())
                        }.buttonStyle(.plain).offset(x: 11, y: -11)
                            .accessibilityLabel("Remove photo \(index + 1)").accessibilityIdentifier("ai-attachment-remove")
                    }
                    .transition(reduceMotion ? .opacity : .scale(scale: 0.6).combined(with: .opacity))
                }
                ForEach(0..<loading, id: \.self) { _ in
                    RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.input).frame(width: 64, height: 64)
                        .overlay(ProgressView().controlSize(.small)).accessibilityLabel("Preparing photo")
                }
            }
            Text("\(images.count + loading)/\(AssistantImageProcessor.maxAttachments)").font(.caption2.weight(.semibold)).monospacedDigit()
                .foregroundStyle(.secondary).frame(maxHeight: .infinity, alignment: .bottom).padding(.bottom, -2)
                .accessibilityHidden(true)
        }.padding(.top, 12).padding(.trailing, 14).padding(.leading, 10).padding(.bottom, 10)
            .fixedSize()
            .caloricGlass(in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .frame(maxWidth: .infinity, alignment: .leading)
            .animation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.82), value: images.map(\.id))
    }
}

struct ImageViewerItem: Identifiable {
    let id = UUID()
    let images: [AssistantImage]
    let index: Int
}

/// Full-screen, swipeable photo viewer with pinch to zoom.
struct AssistantImageViewer: View {
    let item: ImageViewerItem
    @State private var index = 0
    @State private var zoom: CGFloat = 1
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            TabView(selection: $index) {
                ForEach(Array(item.images.enumerated()), id: \.element.id) { offset, image in
                    Image(uiImage: UIImage(data: image.jpeg) ?? image.preview).resizable().scaledToFit()
                        .scaleEffect(offset == index ? zoom : 1)
                        .gesture(MagnifyGesture().onChanged { zoom = max(1, min(4, $0.magnification)) }
                            .onEnded { _ in withAnimation(.spring) { zoom = 1 } })
                        .tag(offset).accessibilityLabel("Photo \(offset + 1) of \(item.images.count)")
                }
            }.tabViewStyle(.page(indexDisplayMode: item.images.count > 1 ? .always : .never)).ignoresSafeArea()
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.system(size: 16, weight: .semibold)).foregroundStyle(.white)
                    .frame(width: 40, height: 40).background(.white.opacity(0.18), in: Circle())
            }.buttonStyle(.plain).padding(16).accessibilityLabel("Close photo")
        }.onAppear { index = item.index }
            .statusBarHidden()
    }
}
