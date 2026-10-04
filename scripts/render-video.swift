import Foundation
import AVFoundation
import AppKit
import CoreVideo

struct Scene: Decodable { let start: Double; let end: Double; let headline: String; let body: String }
struct Palette: Decodable { let graphite: String; let steel: String; let silver: String; let white: String; let muted: String; let blue: String }
struct LogoRect: Decodable { let x: Double; let y: Double; let width: Double; let height: Double }
struct Logo: Decodable { let viewBox: [Double]; let rects: [LogoRect] }
struct Style: Decodable { let colors: Palette; let regularFont: String; let boldFont: String; let logo: Logo?; let brandIdentitySha256: String }
struct Input: Decodable { let width: Int; let height: Int; let fps: Int; let assetId: String; let brand: String; let categoryLabel: String; let style: Style; let scenes: [Scene] }
enum RenderError: Error { case message(String) }

func color(_ hex: String, _ alpha: CGFloat = 1) throws -> NSColor {
    guard hex.range(of: "^#[0-9A-Fa-f]{6}$", options: .regularExpression) != nil,
          let value = UInt32(hex.dropFirst(), radix: 16) else { throw RenderError.message("Invalid identity color") }
    return NSColor(calibratedRed: CGFloat((value >> 16) & 255)/255, green: CGFloat((value >> 8) & 255)/255, blue: CGFloat(value & 255)/255, alpha: alpha)
}

func text(_ string: String, rect: CGRect, size: CGFloat, fontName: String, ink: NSColor) throws {
    guard let font = NSFont(name: fontName, size: size) else { throw RenderError.message("Required identity font is unavailable: \(fontName)") }
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineSpacing = size * 0.13
    paragraph.lineBreakMode = .byWordWrapping
    let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: ink, .paragraphStyle: paragraph]
    let attributed = NSAttributedString(string: string, attributes: attributes)
    let measured = attributed.boundingRect(with: CGSize(width: rect.width, height: 10000), options: [.usesLineFragmentOrigin, .usesFontLeading])
    guard measured.height <= rect.height + 2 else { throw RenderError.message("Video text exceeds readable frame layout: \(string.prefix(60))") }
    attributed.draw(with: rect, options: [.usesLineFragmentOrigin, .usesFontLeading])
}

func frame(_ input: Input, scene: Scene, seconds: Double, pool: CVPixelBufferPool) throws -> CVPixelBuffer {
    var optional: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &optional) == kCVReturnSuccess, let buffer = optional else { throw RenderError.message("Could not allocate video frame") }
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    guard let address = CVPixelBufferGetBaseAddress(buffer), let context = CGContext(data: address, width: input.width, height: input.height, bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { throw RenderError.message("Could not draw video frame") }
    let w = CGFloat(input.width), h = CGFloat(input.height)
    let palette = input.style.colors
    let graphite = try color(palette.graphite), steel = try color(palette.steel), blue = try color(palette.blue)
    context.setFillColor(graphite.cgColor)
    context.fill(CGRect(x: 0,y: 0,width: w,height: h))
    let drift = CGFloat(sin(seconds * 0.32)) * 12
    context.setFillColor(steel.cgColor)
    context.fill(CGRect(x: w-30+drift,y: 0,width: 42,height: h))
    context.setFillColor(blue.cgColor)
    context.fill(CGRect(x: w-10,y: 0,width: 10,height: h))
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
    defer { NSGraphicsContext.restoreGraphicsState() }
    var brandX: CGFloat = 76
    if let logo = input.style.logo {
        guard logo.viewBox.count == 4, logo.viewBox[2] > 0, logo.viewBox[3] > 0, logo.rects.count <= 40 else { throw RenderError.message("Invalid identity logo geometry") }
        let scale = 48 / CGFloat(max(logo.viewBox[2], logo.viewBox[3]))
        context.setFillColor(blue.cgColor)
        for r in logo.rects {
            // SVG coordinates are top-down; Core Graphics frames are bottom-up.
            context.fill(CGRect(x:76+CGFloat(r.x-logo.viewBox[0])*scale,y:h-68-CGFloat(r.y-logo.viewBox[1]+r.height)*scale,width:CGFloat(r.width)*scale,height:CGFloat(r.height)*scale))
        }
        brandX = 142
    }
    try text(input.brand,rect:CGRect(x:brandX,y:h-110,width:700,height:42),size:29,fontName:input.style.boldFont,ink:color(palette.white))
    let elapsed = seconds-scene.start
    let opacity = CGFloat(min(1,max(0.05,elapsed/0.35)))
    let rise = CGFloat(max(0,1-elapsed/0.45)) * 16
    try text(scene.headline,rect:CGRect(x:76,y:330-rise,width:w-152,height:205),size:61,fontName:input.style.boldFont,ink:color(palette.white,opacity))
    try text(scene.body,rect:CGRect(x:78,y:135-rise,width:w-170,height:190),size:34,fontName:input.style.regularFont,ink:color(palette.silver,opacity))
    context.setFillColor(steel.cgColor); context.fill(CGRect(x:76,y:84,width:w-152,height:2))
    let progress = CGFloat((seconds-scene.start)/(scene.end-scene.start))
    context.setFillColor(blue.cgColor); context.fill(CGRect(x:76,y:84,width:(w-152)*max(0,min(1,progress)),height:3))
    try text(input.categoryLabel,rect:CGRect(x:78,y:37,width:900,height:28),size:15,fontName:input.style.regularFont,ink:color(palette.muted))
    try text(input.assetId,rect:CGRect(x:w-168,y:37,width:110,height:28),size:15,fontName:input.style.regularFont,ink:color(palette.muted))
    return buffer
}

func run() throws {
    guard CommandLine.arguments.count == 3 else { throw RenderError.message("Usage: render-video scenes.json output.mp4") }
    let source = URL(fileURLWithPath:CommandLine.arguments[1]); let output = URL(fileURLWithPath:CommandLine.arguments[2])
    let input = try JSONDecoder().decode(Input.self,from:Data(contentsOf:source))
    guard input.width == 1280, input.height == 720, input.fps == 24, !input.scenes.isEmpty, input.scenes.count <= 20, let duration=input.scenes.last?.end, duration > 0, duration <= 180 else { throw RenderError.message("Unsupported video dimensions or duration") }
    let writer = try AVAssetWriter(outputURL:output,fileType:.mp4)
    let settings: [String:Any] = [AVVideoCodecKey:AVVideoCodecType.h264,AVVideoWidthKey:input.width,AVVideoHeightKey:input.height,AVVideoCompressionPropertiesKey:[AVVideoAverageBitRateKey:3_500_000,AVVideoExpectedSourceFrameRateKey:input.fps,AVVideoMaxKeyFrameIntervalKey:input.fps]]
    let video = AVAssetWriterInput(mediaType:.video,outputSettings:settings)
    video.expectsMediaDataInRealTime = false
    let adapter = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput:video,sourcePixelBufferAttributes:[kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32BGRA,kCVPixelBufferWidthKey as String:input.width,kCVPixelBufferHeightKey as String:input.height,kCVPixelBufferCGImageCompatibilityKey as String:true,kCVPixelBufferCGBitmapContextCompatibilityKey as String:true])
    guard writer.canAdd(video) else { throw RenderError.message("Video writer cannot accept the H.264 input") }
    writer.add(video)
    guard writer.startWriting() else { throw RenderError.message("Video writer start failed: \(writer.error?.localizedDescription ?? "unknown error")") }
    writer.startSession(atSourceTime:.zero)
    guard let pool=adapter.pixelBufferPool else { throw RenderError.message("Video pixel-buffer pool is unavailable") }
    let total = Int((duration*Double(input.fps)).rounded())
    for index in 0..<total {
        while !video.isReadyForMoreMediaData {
            if writer.status == .failed { throw RenderError.message("Video encoding failed: \(writer.error?.localizedDescription ?? "unknown error")") }
            Thread.sleep(forTimeInterval:0.002)
        }
        let seconds=Double(index)/Double(input.fps)
        guard let scene=input.scenes.first(where:{$0.start <= seconds && seconds < $0.end}) else { throw RenderError.message("Scene timing gap at \(seconds)") }
        try autoreleasepool {
            let buffer=try frame(input,scene:scene,seconds:seconds,pool:pool)
            guard adapter.append(buffer,withPresentationTime:CMTime(value:Int64(index),timescale:Int32(input.fps))) else { throw RenderError.message("Video frame append failed: \(writer.error?.localizedDescription ?? "unknown error")") }
        }
    }
    video.markAsFinished()
    writer.endSession(atSourceTime:CMTime(seconds:duration,preferredTimescale:600))
    let done=DispatchSemaphore(value:0)
    writer.finishWriting { done.signal() }
    guard done.wait(timeout:.now()+60) == .success, writer.status == .completed else { throw RenderError.message("Video finalization failed: \(writer.error?.localizedDescription ?? "timeout")") }
    // Read back the encoded artifact. A successful writer alone is not the check.
    let asset = AVURLAsset(url:output)
    let generator = AVAssetImageGenerator(asset:asset)
    generator.appliesPreferredTrackTransform = true
    generator.requestedTimeToleranceBefore = .zero
    generator.requestedTimeToleranceAfter = .zero
    var sampled: [String] = []
    for (index, scene) in input.scenes.enumerated() {
        let time=CMTime(seconds:(scene.start+scene.end)/2,preferredTimescale:600)
        let image=try generator.copyCGImage(at:time,actualTime:nil)
        guard image.width == input.width, image.height == input.height else { throw RenderError.message("Encoded frame dimensions differ from source") }
        let name = index == 0 ? "thumbnail.png" : String(format:"scene-%02d-proof.png",index+1)
        guard let png=NSBitmapImageRep(cgImage:image).representation(using:.png,properties:[:]) else { throw RenderError.message("Could not create decoded frame proof") }
        try png.write(to:output.deletingLastPathComponent().appendingPathComponent(name))
        sampled.append(name)
    }
    let tracks=asset.tracks(withMediaType:.video)
    guard let track=tracks.first, abs(asset.duration.seconds-duration) < 0.1, abs(Double(track.nominalFrameRate)-Double(input.fps)) < 0.1 else { throw RenderError.message("Encoded video duration or frame rate differs from scene source") }
    let report: [String:Any] = ["durationSeconds":asset.duration.seconds,"width":input.width,"height":input.height,"fps":track.nominalFrameRate,"audioTrackCount":asset.tracks(withMediaType:.audio).count,"decodedSceneProofs":sampled,"sceneCount":input.scenes.count,"brandIdentitySha256":input.style.brandIdentitySha256,"regularFont":input.style.regularFont,"boldFont":input.style.boldFont]
    try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]).write(to:output.deletingLastPathComponent().appendingPathComponent("video-verification.json"))
    print("Encoded \(total) frames; \(duration)s; \(input.width)x\(input.height); silent H.264 MP4")
}

do { try run() } catch { fputs("\(error)\n",stderr); exit(1) }
