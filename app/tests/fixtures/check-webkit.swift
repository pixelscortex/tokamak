import AppKit
import WebKit

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 900, height: 700))
let window = NSWindow(contentRect: web.frame, styleMask: [.titled], backing: .buffered, defer: false)
window.contentView = web
let address = CommandLine.arguments.dropFirst().first ?? "http://127.0.0.1:4173/tests/fixtures/check.html?assets=http%3A%2F%2F127.0.0.1%3A4174"
web.load(URLRequest(url: URL(string: address)!))
let deadline = Date().addingTimeInterval(40)
var evaluating = false
let timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
    if Date() > deadline {
        fputs("FAIL WKWebView timed out\n", stderr)
        exit(1)
    }
    if evaluating { return }
    evaluating = true
    web.evaluateJavaScript("({status: document.getElementById('result')?.dataset.status, result: document.getElementById('result')?.textContent, agent: navigator.userAgent})") { value, error in
        evaluating = false
        guard let state = value as? [String: Any], let status = state["status"] as? String else { return }
        print(state["agent"] ?? "WKWebView")
        print(state["result"] ?? "No result")
        exit(status == "passed" ? 0 : 1)
    }
}
app.run()
