import Foundation
import AppKit
import CoreText
import PDFKit

// Local, input-driven collateral. No product facts or fixed campaign copy live here.
struct Block: Decodable { let kind: String; let text: String }
struct Palette: Decodable { let graphite: String; let steel: String; let silver: String; let white: String; let muted: String; let blue: String }
struct LogoRect: Decodable { let x: Double; let y: Double; let width: Double; let height: Double }
struct Logo: Decodable { let viewBox: [Double]; let rects: [LogoRect] }
struct Style: Decodable { let colors: Palette; let regularFont: String; let boldFont: String; let logo: Logo? }
struct Input: Decodable { let assetId: String; let brand: String; let title: String; let label: String; let sourceSha256: String; let brandIdentitySha256: String; let style: Style; let blocks: [Block] }
enum RenderError: Error { case message(String) }

func color(_ hex: String) throws -> CGColor {
    guard hex.range(of: "^#[0-9A-Fa-f]{6}$", options: .regularExpression) != nil,
          let v = UInt32(hex.dropFirst(), radix: 16) else { throw RenderError.message("Invalid PDF color") }
    return CGColor(red: CGFloat((v >> 16) & 255)/255, green: CGFloat((v >> 8) & 255)/255, blue: CGFloat(v & 255)/255, alpha: 1)
}

func attributed(_ text: String, size: CGFloat, font: String, ink: CGColor) throws -> NSAttributedString {
    guard let face = NSFont(name: font, size: size) else { throw RenderError.message("Required PDF font unavailable") }
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineSpacing = size * 0.28
    paragraph.lineBreakMode = .byWordWrapping
    return NSAttributedString(string: text, attributes: [.font: face, .foregroundColor: NSColor(cgColor: ink)!, .paragraphStyle: paragraph])
}

func height(_ text: NSAttributedString, width: CGFloat) -> CGFloat {
    let setter = CTFramesetterCreateWithAttributedString(text)
    return ceil(CTFramesetterSuggestFrameSizeWithConstraints(setter, CFRange(location: 0, length: text.length), nil, CGSize(width: width, height: 10000), nil).height) + 4
}

func draw(_ text: NSAttributedString, x: CGFloat, top: CGFloat, width: CGFloat, context: CGContext) throws {
    let h = height(text, width: width)
    let setter = CTFramesetterCreateWithAttributedString(text)
    let frame = CTFramesetterCreateFrame(setter, CFRange(location: 0, length: text.length), CGPath(rect: CGRect(x: x, y: top-h, width: width, height: h), transform: nil), nil)
    guard CTFrameGetVisibleStringRange(frame).length == text.length else { throw RenderError.message("PDF text does not fit") }
    context.textMatrix = .identity
    CTFrameDraw(frame, context)
}

func normalized(_ text: String) -> String {
    text.precomposedStringWithCanonicalMapping.components(separatedBy: .whitespacesAndNewlines).joined()
}

func run() throws {
    guard CommandLine.arguments.count == 4 else { throw RenderError.message("Expected input, PDF and verification paths") }
    let input = try JSONDecoder().decode(Input.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
    guard !input.blocks.isEmpty, input.blocks.count <= 500 else { throw RenderError.message("PDF requires bounded content") }
    let output = URL(fileURLWithPath: CommandLine.arguments[2])
    let palette = input.style.colors
    let dark = try color(palette.graphite), blue = try color(palette.blue), steel = try color(palette.steel), white = try color(palette.white), silver = try color(palette.silver)
    var box = CGRect(x: 0, y: 0, width: 612, height: 792)
    let info = [kCGPDFContextTitle as String: input.title, kCGPDFContextAuthor as String: input.brand, kCGPDFContextCreator as String: "Campaign Control"] as CFDictionary
    guard let context = CGContext(output as CFURL, mediaBox: &box, info) else { throw RenderError.message("Could not create PDF") }
    var page = 0
    func beginPage() throws -> CGFloat {
        page += 1
        guard page <= 8 else { throw RenderError.message("Collateral exceeds eight readable pages") }
        context.beginPDFPage(nil)
        context.setFillColor(CGColor(gray: 1, alpha: 1)); context.fill(box)
        context.setFillColor(dark); context.fill(CGRect(x: 0, y: 684, width: 612, height: 108))
        context.setFillColor(blue); context.fill(CGRect(x: 0, y: 680, width: 612, height: 4))
        var brandX: CGFloat = 44
        if let logo = input.style.logo {
            guard logo.viewBox.count == 4, logo.viewBox[2] > 0, logo.viewBox[3] > 0, logo.rects.count <= 40 else { throw RenderError.message("Invalid PDF logo") }
            let scale = 28 / CGFloat(max(logo.viewBox[2], logo.viewBox[3]))
            for r in logo.rects {
                context.fill(CGRect(x:44+CGFloat(r.x-logo.viewBox[0])*scale, y:757-CGFloat(r.y-logo.viewBox[1]+r.height)*scale, width:CGFloat(r.width)*scale, height:CGFloat(r.height)*scale))
            }
            brandX = 85
        }
        try draw(attributed(input.brand, size: 19, font: input.style.boldFont, ink: white), x: brandX, top: 758, width: 380, context: context)
        try draw(attributed(input.label.uppercased(), size: 9, font: input.style.boldFont, ink: silver), x: 44, top: 709, width: 400, context: context)
        context.setStrokeColor(silver); context.move(to: CGPoint(x:44,y:43)); context.addLine(to: CGPoint(x:568,y:43)); context.strokePath()
        try draw(attributed("\(input.assetId)  /  \(page)", size: 8, font: input.style.regularFont, ink: steel), x: 44, top: 31, width: 250, context: context)
        return 650
    }
    var y = try beginPage()
    for (index, block) in input.blocks.enumerated() {
        let title = block.kind == "title", heading = block.kind == "heading"
        let size: CGFloat = title ? 27 : heading ? 12.5 : 10.5
        let spaceBefore: CGFloat = title ? 0 : heading ? 12 : 2
        let value = try attributed(block.text, size: size, font: title || heading ? input.style.boldFont : input.style.regularFont, ink: title || heading ? dark : steel)
        let h = height(value, width: 524)
        guard h <= 570 else { throw RenderError.message("A PDF paragraph is too long; split it into shorter paragraphs") }
        // Keep headings with the next paragraph, rather than stranding a label at the foot.
        let keep: CGFloat = (title || heading) && index+1 < input.blocks.count ? min(90, height(try attributed(input.blocks[index+1].text,size:10.5,font:input.style.regularFont,ink:steel),width:524)) : 0
        if y-spaceBefore-h-keep < 66 { context.endPDFPage(); y = try beginPage() }
        y -= spaceBefore
        try draw(value, x: 44, top: y, width: 524, context: context)
        y -= h + (title ? 10 : 7)
    }
    context.endPDFPage(); context.closePDF()
    guard let document = PDFDocument(url: output), document.pageCount == page, let extracted = document.string else { throw RenderError.message("PDF could not be reopened") }
    let allText = normalized(extracted)
    guard input.blocks.allSatisfy({allText.contains(normalized($0.text))}) else { throw RenderError.message("PDF text verification failed; source copy is missing") }
    guard let first = document.page(at:0), let bitmap = first.thumbnail(of:CGSize(width:918,height:1188),for:.mediaBox).tiffRepresentation,
          let rep = NSBitmapImageRep(data:bitmap), let png = rep.representation(using:.png,properties:[:]) else { throw RenderError.message("PDF preview could not be rendered") }
    try png.write(to:output.deletingLastPathComponent().appendingPathComponent("document-preview.png"))
    let proof: [String: Any] = ["assetId": input.assetId, "sourceSha256":input.sourceSha256, "brandIdentitySha256":input.brandIdentitySha256, "pageCount":page, "textVerified":true, "createdAtUTC":ISO8601DateFormatter().string(from:Date())]
    try JSONSerialization.data(withJSONObject: proof, options: [.prettyPrinted,.sortedKeys]).write(to: URL(fileURLWithPath:CommandLine.arguments[3]))
}

do { try run() } catch {
    fputs("PDF rendering failed: \(error)\n", stderr)
    exit(1)
}
