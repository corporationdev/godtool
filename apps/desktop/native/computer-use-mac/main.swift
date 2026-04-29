import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import Network
import ScreenCaptureKit

_ = NSApplication.shared

enum ComputerUseError: Error, CustomStringConvertible {
  case badRequest(String)
  case notFound(String)
  case accessibilityPermissionRequired
  case screenRecordingPermissionRequired
  case accessibility(String)
  case screenCapture(String)

  var description: String {
    switch self {
    case .badRequest(let message): return message
    case .notFound(let message): return message
    case .accessibilityPermissionRequired:
      return "accessibility_permission_required"
    case .screenRecordingPermissionRequired:
      return "screen_recording_permission_required"
    case .accessibility(let message): return message
    case .screenCapture(let message): return message
    }
  }
}

struct RequestContext {
  let method: String
  let path: String
  let body: Data
}

final class ElementCache {
  private var elements: [String: [Int: AXUIElement]] = [:]

  func set(app: String, elements next: [Int: AXUIElement]) {
    elements[app.lowercased()] = next
  }

  func get(app: String, index: String) throws -> AXUIElement {
    guard let number = Int(index.trimmingCharacters(in: .whitespacesAndNewlines)) else {
      throw ComputerUseError.badRequest("element_index must be an integer string")
    }
    guard let element = elements[app.lowercased()]?[number] else {
      throw ComputerUseError.notFound("element_index \(index) is not present in the latest snapshot for \(app)")
    }
    return element
  }
}

let cache = ElementCache()

let maxSnapshotElements = 2_000
let maxSnapshotDepth = 80

func jsonObject(_ data: Data) throws -> [String: Any] {
  if data.isEmpty { return [:] }
  guard
    let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
  else {
    throw ComputerUseError.badRequest("Expected a JSON object request body")
  }
  return object
}

func stringArg(_ object: [String: Any], _ key: String) throws -> String {
  guard let value = object[key] as? String, !value.isEmpty else {
    throw ComputerUseError.badRequest("\(key) is required")
  }
  return value
}

func doubleArg(_ object: [String: Any], _ key: String) -> Double? {
  if let value = object[key] as? Double { return value }
  if let value = object[key] as? Int { return Double(value) }
  return nil
}

func boolAX(_ value: AnyObject?) -> Bool? {
  guard let value else { return nil }
  return CFGetTypeID(value) == CFBooleanGetTypeID() ? CFBooleanGetValue((value as! CFBoolean)) : nil
}

func stringAX(_ value: AnyObject?) -> String? {
  guard let value else { return nil }
  if CFGetTypeID(value) == AXValueGetTypeID() { return nil }
  return value as? String
}

func axAttribute(_ element: AXUIElement, _ attribute: String) -> AnyObject? {
  var value: AnyObject?
  let error = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
  return error == .success ? value : nil
}

func axString(_ element: AXUIElement, _ attribute: String) -> String? {
  stringAX(axAttribute(element, attribute))
}

func axBool(_ element: AXUIElement, _ attribute: String) -> Bool? {
  boolAX(axAttribute(element, attribute))
}

func axPoint(_ element: AXUIElement, _ attribute: String) -> CGPoint? {
  guard let value = axAttribute(element, attribute), CFGetTypeID(value) == AXValueGetTypeID() else {
    return nil
  }
  var point = CGPoint.zero
  return AXValueGetValue((value as! AXValue), .cgPoint, &point) ? point : nil
}

func axSize(_ element: AXUIElement, _ attribute: String) -> CGSize? {
  guard let value = axAttribute(element, attribute), CFGetTypeID(value) == AXValueGetTypeID() else {
    return nil
  }
  var size = CGSize.zero
  return AXValueGetValue((value as! AXValue), .cgSize, &size) ? size : nil
}

func axFrame(_ element: AXUIElement) -> CGRect? {
  guard let point = axPoint(element, kAXPositionAttribute), let size = axSize(element, kAXSizeAttribute) else {
    return nil
  }
  return CGRect(origin: point, size: size)
}

func axChildren(_ element: AXUIElement) -> [AXUIElement] {
  guard let children = axAttribute(element, kAXChildrenAttribute) as? [AXUIElement] else {
    return []
  }
  return children
}

func axActions(_ element: AXUIElement) -> [String] {
  var names: CFArray?
  let error = AXUIElementCopyActionNames(element, &names)
  guard error == .success, let names else { return [] }
  return (names as? [String]) ?? []
}

func normalizedActionName(_ action: String) -> String {
  action
    .replacingOccurrences(of: "AX", with: "")
    .replacingOccurrences(of: "Action", with: "")
}

func appMatches(_ app: NSRunningApplication, query: String) -> Bool {
  let q = query.lowercased()
  if String(app.processIdentifier) == q { return true }
  if app.bundleIdentifier?.lowercased() == q { return true }
  if app.localizedName?.lowercased() == q { return true }
  return false
}

func runningApp(_ query: String) throws -> NSRunningApplication {
  if let app = NSWorkspace.shared.runningApplications.first(where: { appMatches($0, query: query) }) {
    return app
  }
  throw ComputerUseError.notFound("No running app matched \(query)")
}

func assertAccessibility() throws {
  if !AXIsProcessTrusted() {
    throw ComputerUseError.accessibilityPermissionRequired
  }
}

func assertScreenRecording() throws {
  if !CGPreflightScreenCaptureAccess() {
    throw ComputerUseError.screenRecordingPermissionRequired
  }
}

func focusedWindow(for app: NSRunningApplication) throws -> AXUIElement {
  try assertAccessibility()
  let root = AXUIElementCreateApplication(app.processIdentifier)
  if let window = axAttribute(root, kAXFocusedWindowAttribute) {
    return (window as! AXUIElement)
  }
  if let windows = axAttribute(root, kAXWindowsAttribute) as? [AXUIElement], let first = windows.first {
    return first
  }
  throw ComputerUseError.accessibility("No accessible window found for \(app.localizedName ?? String(app.processIdentifier))")
}

func lineForElement(index: Int, element: AXUIElement, actions: [String]) -> String {
  let role = axString(element, kAXRoleAttribute) ?? "unknown"
  let title = axString(element, kAXTitleAttribute)
  let description = axString(element, kAXDescriptionAttribute)
  let value = axString(element, kAXValueAttribute)
  let help = axString(element, kAXHelpAttribute)
  let selected = axBool(element, kAXSelectedAttribute) == true ? "selected" : nil
  let enabled = axBool(element, kAXEnabledAttribute) == false ? "disabled" : nil
  let expanded = axBool(element, kAXExpandedAttribute).map { $0 ? "expanded" : "collapsed" }
  let state = [selected, enabled, expanded].compactMap { $0 }
  let stateText = state.isEmpty ? "" : " (\(state.joined(separator: ", ")))"
  let titleText = title.map { " \($0)" } ?? ""
  let details = [
    description.map { "Description: \($0)" },
    value.map { "Value: \($0)" },
    help.map { "Help: \($0)" },
    actions.isEmpty ? nil : "Secondary Actions: \(actions.map(normalizedActionName).joined(separator: ", "))",
  ].compactMap { $0 }
  return "\(index) \(role)\(stateText)\(titleText)" + (details.isEmpty ? "" : " " + details.joined(separator: ", "))
}

func snapshot(app query: String) throws -> [String: Any] {
  let app = try runningApp(query)
  try assertAccessibility()
  try assertScreenRecording()

  let window = try focusedWindow(for: app)
  let windowTitle = axString(window, kAXTitleAttribute) ?? ""
  var lines: [String] = [
    "Computer Use state (Godtool Computer Use Version: 1)",
    "<app_state>",
    "App=\(app.bundleIdentifier ?? String(app.processIdentifier)) (pid \(app.processIdentifier))",
    "Window: \"\(windowTitle)\", App: \(app.localizedName ?? app.bundleIdentifier ?? "Unknown").",
  ]
  var indexed: [Int: AXUIElement] = [:]
  var nextIndex = 0

  func visit(_ element: AXUIElement, depth: Int) {
    guard nextIndex < maxSnapshotElements, depth < maxSnapshotDepth else { return }
    let index = nextIndex
    nextIndex += 1
    indexed[index] = element
    lines.append(String(repeating: "\t", count: depth) + lineForElement(index: index, element: element, actions: axActions(element)))
    for child in axChildren(element) {
      visit(child, depth: depth + 1)
    }
  }

  visit(window, depth: 1)
  lines.append("</app_state>")
  cache.set(app: query, elements: indexed)

  let screenshot = try screenshotForApp(app, windowTitle: windowTitle)
  return [
    "text": lines.joined(separator: "\n"),
    "screenshot": [
      "mimeType": "image/png",
      "data": screenshot.base64EncodedString(),
    ],
  ]
}

func screenshotForApp(_ app: NSRunningApplication, windowTitle: String) throws -> Data {
  try assertScreenRecording()
  let semaphore = DispatchSemaphore(value: 0)
  var result: Result<Data, Error>?

  SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, error in
    if let error {
      result = .failure(ComputerUseError.screenCapture(error.localizedDescription))
      semaphore.signal()
      return
    }
    guard let content else {
      result = .failure(ComputerUseError.screenCapture("ScreenCaptureKit did not return shareable content"))
      semaphore.signal()
      return
    }
    let windows = content.windows.filter {
      $0.owningApplication?.processID == app.processIdentifier && $0.isOnScreen && $0.frame.width > 0 && $0.frame.height > 0
    }
    let window = windows.first(where: { ($0.title ?? "") == windowTitle }) ?? windows.first(where: { $0.isActive }) ?? windows.first
    guard let window else {
      result = .failure(ComputerUseError.screenCapture("No ScreenCaptureKit window found for \(app.localizedName ?? String(app.processIdentifier))"))
      semaphore.signal()
      return
    }
    let config = SCStreamConfiguration()
    config.width = max(1, Int(window.frame.width))
    config.height = max(1, Int(window.frame.height))
    config.showsCursor = false
    let filter = SCContentFilter(desktopIndependentWindow: window)
    SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) { image, captureError in
      if let captureError {
        result = .failure(ComputerUseError.screenCapture(captureError.localizedDescription))
      } else if let image {
        let rep = NSBitmapImageRep(cgImage: image)
        if let data = rep.representation(using: .png, properties: [:]) {
          result = .success(data)
        } else {
          result = .failure(ComputerUseError.screenCapture("Could not encode screenshot as PNG"))
        }
      } else {
        result = .failure(ComputerUseError.screenCapture("ScreenCaptureKit returned no image"))
      }
      semaphore.signal()
    }
  }

  semaphore.wait()
  return try result!.get()
}

func clickMouse(x: Double, y: Double, button: String, count: Int) {
  let location = CGPoint(x: x, y: y)
  let cgButton: CGMouseButton = button == "right" ? .right : button == "middle" ? .center : .left
  let down: CGEventType = button == "right" ? .rightMouseDown : button == "middle" ? .otherMouseDown : .leftMouseDown
  let up: CGEventType = button == "right" ? .rightMouseUp : button == "middle" ? .otherMouseUp : .leftMouseUp
  for _ in 0..<max(1, count) {
    CGEvent(mouseEventSource: nil, mouseType: down, mouseCursorPosition: location, mouseButton: cgButton)?.post(tap: .cghidEventTap)
    CGEvent(mouseEventSource: nil, mouseType: up, mouseCursorPosition: location, mouseButton: cgButton)?.post(tap: .cghidEventTap)
  }
}

func dragMouse(fromX: Double, fromY: Double, toX: Double, toY: Double) {
  let start = CGPoint(x: fromX, y: fromY)
  let end = CGPoint(x: toX, y: toY)
  CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: start, mouseButton: .left)?
    .post(tap: .cghidEventTap)

  let steps = 24
  for step in 1...steps {
    let progress = Double(step) / Double(steps)
    let point = CGPoint(
      x: fromX + (toX - fromX) * progress,
      y: fromY + (toY - fromY) * progress
    )
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: point, mouseButton: .left)?
      .post(tap: .cghidEventTap)
    usleep(5_000)
  }

  CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: end, mouseButton: .left)?
    .post(tap: .cghidEventTap)
}

func click(_ body: [String: Any]) throws -> [String: Any] {
  try assertAccessibility()
  let app = try stringArg(body, "app")
  let count = Int(doubleArg(body, "click_count") ?? 1)
  let button = (body["mouse_button"] as? String) ?? "left"
  if let index = body["element_index"] as? String {
    let element = try cache.get(app: app, index: index)
    let actions = axActions(element)
    if actions.contains(kAXPressAction) {
      let error = AXUIElementPerformAction(element, kAXPressAction as CFString)
      if error != .success {
        throw ComputerUseError.accessibility("AXPress failed with \(error.rawValue)")
      }
      return ["clicked": true, "element_index": index]
    }
    guard let frame = axFrame(element) else {
      throw ComputerUseError.accessibility("Element \(index) does not expose a frame")
    }
    clickMouse(x: frame.midX, y: frame.midY, button: button, count: count)
    return ["clicked": true, "element_index": index]
  }

  guard let x = doubleArg(body, "x"), let y = doubleArg(body, "y") else {
    throw ComputerUseError.badRequest("click requires element_index or x and y")
  }
  clickMouse(x: x, y: y, button: button, count: count)
  return ["clicked": true, "x": x, "y": y]
}

func drag(_ body: [String: Any]) throws -> [String: Any] {
  try assertAccessibility()
  _ = try stringArg(body, "app")
  guard
    let fromX = doubleArg(body, "from_x"),
    let fromY = doubleArg(body, "from_y"),
    let toX = doubleArg(body, "to_x"),
    let toY = doubleArg(body, "to_y")
  else {
    throw ComputerUseError.badRequest("drag requires from_x, from_y, to_x, and to_y")
  }
  dragMouse(fromX: fromX, fromY: fromY, toX: toX, toY: toY)
  return ["dragged": true, "from_x": fromX, "from_y": fromY, "to_x": toX, "to_y": toY]
}

func scroll(_ body: [String: Any]) throws -> [String: Any] {
  try assertAccessibility()
  let app = try stringArg(body, "app")
  let index = try stringArg(body, "element_index")
  let direction = try stringArg(body, "direction")
  let pages = doubleArg(body, "pages") ?? 1
  let element = try cache.get(app: app, index: index)
  guard let frame = axFrame(element) else {
    throw ComputerUseError.accessibility("Element \(index) does not expose a frame")
  }
  let vertical = direction == "up" ? Int32(6 * pages) : direction == "down" ? Int32(-6 * pages) : 0
  let horizontal = direction == "left" ? Int32(6 * pages) : direction == "right" ? Int32(-6 * pages) : 0
  CGWarpMouseCursorPosition(CGPoint(x: frame.midX, y: frame.midY))
  CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: vertical, wheel2: horizontal, wheel3: 0)?
    .post(tap: .cghidEventTap)
  return ["scrolled": true, "element_index": index, "direction": direction, "pages": pages]
}

func setValue(_ body: [String: Any]) throws -> [String: Any] {
  try assertAccessibility()
  let app = try stringArg(body, "app")
  let index = try stringArg(body, "element_index")
  let value = try stringArg(body, "value")
  let element = try cache.get(app: app, index: index)
  let error = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFTypeRef)
  if error != .success {
    throw ComputerUseError.accessibility("Setting AXValue failed with \(error.rawValue)")
  }
  return ["set": true, "element_index": index]
}

func performSecondaryAction(_ body: [String: Any]) throws -> [String: Any] {
  try assertAccessibility()
  let app = try stringArg(body, "app")
  let index = try stringArg(body, "element_index")
  let requested = try stringArg(body, "action")
  let element = try cache.get(app: app, index: index)
  let actions = axActions(element)
  let action = actions.first {
    $0 == requested || normalizedActionName($0).lowercased() == requested.lowercased()
  } ?? requested
  let error = AXUIElementPerformAction(element, action as CFString)
  if error != .success {
    throw ComputerUseError.accessibility("Action \(requested) failed with \(error.rawValue)")
  }
  return ["performed": action, "element_index": index]
}

let keyCodes: [String: CGKeyCode] = [
  "return": 36, "enter": 36, "tab": 48, "space": 49, "escape": 53, "esc": 53,
  "delete": 51, "backspace": 51, "up": 126, "down": 125, "left": 123, "right": 124,
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
  "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
  "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28,
  "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38,
  "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47,
  "`": 50,
]

func flagsFor(_ parts: [String]) -> CGEventFlags {
  var flags = CGEventFlags()
  for part in parts {
    switch part.lowercased() {
    case "cmd", "command", "super", "meta": flags.insert(.maskCommand)
    case "shift": flags.insert(.maskShift)
    case "ctrl", "control": flags.insert(.maskControl)
    case "alt", "option": flags.insert(.maskAlternate)
    default: break
    }
  }
  return flags
}

func pressKey(_ body: [String: Any]) throws -> [String: Any] {
  try assertAccessibility()
  _ = try stringArg(body, "app")
  let key = try stringArg(body, "key")
  let parts = key.split(separator: "+").map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
  guard let base = parts.last?.lowercased(), let keyCode = keyCodes[base] else {
    throw ComputerUseError.badRequest("Unsupported key: \(key)")
  }
  let flags = flagsFor(Array(parts.dropLast()))
  let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true)
  down?.flags = flags
  down?.post(tap: .cghidEventTap)
  let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false)
  up?.flags = flags
  up?.post(tap: .cghidEventTap)
  return ["pressed": key]
}

func typeText(_ body: [String: Any]) throws -> [String: Any] {
  try assertAccessibility()
  _ = try stringArg(body, "app")
  let text = try stringArg(body, "text")
  for scalar in text.unicodeScalars {
    var value = UniChar(scalar.value)
    let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
    down?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &value)
    down?.post(tap: .cghidEventTap)
    let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
    up?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &value)
    up?.post(tap: .cghidEventTap)
  }
  return ["typed": true]
}

func listApps() -> [[String: Any]] {
  NSWorkspace.shared.runningApplications
    .filter { $0.activationPolicy == .regular }
    .map {
      [
        "name": $0.localizedName ?? "",
        "bundleIdentifier": $0.bundleIdentifier ?? "",
        "pid": Int($0.processIdentifier),
        "running": !$0.isTerminated,
        "active": $0.isActive,
      ]
    }
}

func route(_ request: RequestContext) throws -> Any {
  switch (request.method, request.path) {
  case ("GET", "/health"):
    return ["ok": true]
  case ("GET", "/apps"):
    return listApps()
  case ("POST", "/state"):
    let body = try jsonObject(request.body)
    return try snapshot(app: stringArg(body, "app"))
  case ("POST", "/click"):
    return try click(jsonObject(request.body))
  case ("POST", "/drag"):
    return try drag(jsonObject(request.body))
  case ("POST", "/scroll"):
    return try scroll(jsonObject(request.body))
  case ("POST", "/set-value"):
    return try setValue(jsonObject(request.body))
  case ("POST", "/secondary-action"):
    return try performSecondaryAction(jsonObject(request.body))
  case ("POST", "/press-key"):
    return try pressKey(jsonObject(request.body))
  case ("POST", "/type-text"):
    return try typeText(jsonObject(request.body))
  case ("GET", "/permissions/status"):
    return [
      "accessibility": AXIsProcessTrusted(),
      "screenRecording": CGPreflightScreenCaptureAccess(),
    ]
  case ("POST", "/permissions/accessibility/request"):
    _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeRetainedValue() as String: true] as CFDictionary)
    return [
      "accessibility": AXIsProcessTrusted(),
      "screenRecording": CGPreflightScreenCaptureAccess(),
    ]
  case ("POST", "/permissions/screen-recording/request"):
    _ = CGRequestScreenCaptureAccess()
    return [
      "accessibility": AXIsProcessTrusted(),
      "screenRecording": CGPreflightScreenCaptureAccess(),
    ]
  default:
    throw ComputerUseError.notFound("Not found: \(request.method) \(request.path)")
  }
}

func response(status: Int, object: Any) -> Data {
  let body = try! JSONSerialization.data(withJSONObject: object, options: [])
  let reason = status >= 400 ? "Error" : "OK"
  let headers = "HTTP/1.1 \(status) \(reason)\r\ncontent-type: application/json\r\ncontent-length: \(body.count)\r\nconnection: close\r\n\r\n"
  var data = Data(headers.utf8)
  data.append(body)
  return data
}

func parseRequest(_ data: Data) throws -> RequestContext {
  guard let raw = String(data: data, encoding: .utf8) else {
    throw ComputerUseError.badRequest("Request is not UTF-8")
  }
  let parts = raw.components(separatedBy: "\r\n\r\n")
  let head = parts.first ?? ""
  let bodyString = parts.dropFirst().joined(separator: "\r\n\r\n")
  let requestLine = head.split(separator: "\r\n").first?.split(separator: " ")
  guard let requestLine, requestLine.count >= 2 else {
    throw ComputerUseError.badRequest("Malformed HTTP request")
  }
  return RequestContext(method: String(requestLine[0]), path: String(requestLine[1]), body: Data(bodyString.utf8))
}

final class Server {
  let listener: NWListener

  init(port: UInt16) throws {
    listener = try NWListener(using: .tcp, on: NWEndpoint.Port(rawValue: port)!)
  }

  func start() {
    listener.newConnectionHandler = { connection in
      connection.start(queue: .global())
      connection.receive(minimumIncompleteLength: 1, maximumLength: 1_048_576) { data, _, _, _ in
        let output: Data
        do {
          let request = try parseRequest(data ?? Data())
          let value = try route(request)
          output = response(status: 200, object: ["ok": true, "value": value])
        } catch {
          output = response(status: 500, object: ["ok": false, "error": String(describing: error)])
        }
        connection.send(content: output, completion: .contentProcessed { _ in
          connection.cancel()
        })
      }
    }
    listener.start(queue: .main)
  }
}

let port: UInt16 = {
  if let index = CommandLine.arguments.firstIndex(of: "--port"),
    CommandLine.arguments.indices.contains(index + 1),
    let value = UInt16(CommandLine.arguments[index + 1])
  {
    return value
  }
  return 14790
}()

do {
  let server = try Server(port: port)
  server.start()
  print("[computer-use] host listening on http://127.0.0.1:\(port)")
  RunLoop.main.run()
} catch {
  fputs("[computer-use] failed to start: \(error)\n", stderr)
  exit(1)
}
