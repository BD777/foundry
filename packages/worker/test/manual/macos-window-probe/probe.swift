import AppKit
import ApplicationServices
import Darwin

// Read-only WindowServer keyboard-focus probe; unavailable is reported, never inferred.
func keyFocusPID() -> Int32? {
 typealias ReadFocus = @convention(c) (UnsafeMutableRawPointer, UnsafeMutableRawPointer) -> Int32
 typealias PIDForPSN = @convention(c) (UnsafeRawPointer, UnsafeMutablePointer<Int32>) -> Int32
 guard let sky = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY),
       let proc = dlopen(nil, RTLD_LAZY),
       let a = dlsym(sky,"SLPSGetKeyFocusProcess"), let b = dlsym(proc,"GetProcessPID") else { return nil }
 let get = unsafeBitCast(a,to:ReadFocus.self), resolve = unsafeBitCast(b,to:PIDForPSN.self)
 var psn: UInt64 = 0; var connection: UInt64 = 0; var pid: Int32 = 0
 guard get(&psn,&connection) == 0, psn != 0, resolve(&psn,&pid) == 0 else { return nil }
 return pid
}
// Separate bounded, read-only sampler starts before the synthetic App.
if CommandLine.arguments.count > 2 && CommandLine.arguments[1] == "--monitor" {
 let output = CommandLine.arguments[2]
 let pointer = NSEvent.mouseLocation
 let front = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
 let focus = keyFocusPID()
 let clipboard = NSPasteboard.general.changeCount
 var pointerChanged = false, frontChanged = false, focusChanged = false, clipboardChanged = false
 let tick: () -> Void = {
  let currentFocus = keyFocusPID()
  pointerChanged = pointerChanged || NSEvent.mouseLocation != pointer
  frontChanged = frontChanged || (NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0) != front
  focusChanged = focusChanged || (focus != nil && currentFocus != nil && focus != currentFocus)
  clipboardChanged = clipboardChanged || NSPasteboard.general.changeCount != clipboard
  let state: [String: Any] = ["pointer_changed":pointerChanged,"frontmost_changed":frontChanged,"keyboard_focus_available":focus != nil && currentFocus != nil,"keyboard_focus_changed":focusChanged,"clipboard_changed":clipboardChanged]
  if let data = try? JSONSerialization.data(withJSONObject:state,options:[.sortedKeys]) { try? data.write(to:URL(fileURLWithPath:output),options:.atomic) }
 }
 tick()
 Timer.scheduledTimer(withTimeInterval:0.01,repeats:true) { _ in tick() }
 Timer.scheduledTimer(withTimeInterval:300,repeats:false) { _ in exit(0) }
 RunLoop.current.run()
 exit(0)
}
// Synthetic controls only. Does not activate or make its window key.
final class Probe: NSObject, NSApplicationDelegate {
 var window: NSWindow!
 var field: NSTextField!
 var count = 0
 let output = CommandLine.arguments[1]
 var baselinePointer = NSEvent.mouseLocation
 var baselineFront = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
 var baselinePasteboard = NSPasteboard.general.changeCount
 var frontChanged = false
 var pointerChanged = false
 var clipboardChanged = false
 var baselineFocus = keyFocusPID()
 var focusChanged = false
 var lastCommand = ""
 var scroll: NSScrollView!
 func applicationDidFinishLaunching(_ notification: Notification) {
  window = NSWindow(contentRect:NSRect(x:80,y:80,width:420,height:280), styleMask:[.titled,.closable], backing:.buffered, defer:false)
  window.title = "Foundry DEV028 synthetic controls"
  field = NSTextField(frame:NSRect(x:20,y:210,width:360,height:26))
  field.stringValue = "initial"
  field.setAccessibilityIdentifier("dev028-field")
  let button = NSButton(title:"Increment synthetic counter",target:self,action:#selector(increment))
  button.frame = NSRect(x:20,y:160,width:280,height:32)
  button.setAccessibilityIdentifier("dev028-increment")
  window.contentView!.addSubview(field)
  window.contentView!.addSubview(button)
  scroll = NSScrollView(frame:NSRect(x:20,y:15,width:360,height:125))
  scroll.hasVerticalScroller = true
  let text = NSTextView(frame:NSRect(x:0,y:0,width:330,height:1400))
  text.string = (0..<60).map { "Synthetic line \($0)" }.joined(separator:"\n")
  text.isEditable = false
  scroll.documentView = text
  window.contentView!.addSubview(scroll)
  window.setAccessibilityElement(true)
  window.setAccessibilityRole(.window)
  window.setAccessibilityChildren([field!,button,scroll!])
  NSApp.setAccessibilityChildren([window!])
  window.orderBack(nil)
  Timer.scheduledTimer(withTimeInterval:0.01,repeats:true) { _ in self.record() }
  Timer.scheduledTimer(withTimeInterval:300,repeats:false) { _ in NSApp.terminate(nil) }
 }
 @objc func increment(){ count += 1; record() }
 func record(){
  if let command = try? String(contentsOfFile:output+".command",encoding:.utf8), command != lastCommand {
   lastCommand = command
   if command.hasPrefix("reset") {
    baselinePointer=NSEvent.mouseLocation; baselineFront=NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0; baselineFocus=keyFocusPID(); baselinePasteboard=NSPasteboard.general.changeCount
    frontChanged=false; pointerChanged=false; clipboardChanged=false; focusChanged=false
   } else if command == "close" { window.orderOut(nil) }
   else if command == "resize" { window.setContentSize(NSSize(width:450,height:300)) }
   else if command == "minimize" { window.miniaturize(nil) }
   else if command == "exit" { NSApp.terminate(nil) }
  }
  let p = NSEvent.mouseLocation
  pointerChanged = pointerChanged || p != baselinePointer
  frontChanged = frontChanged || (NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0) != baselineFront
  clipboardChanged = clipboardChanged || NSPasteboard.general.changeCount != baselinePasteboard
  let focus=keyFocusPID()
  focusChanged = focusChanged || (focus != nil && baselineFocus != nil && focus != baselineFocus)
  let value:[String:Any] = ["pid":ProcessInfo.processInfo.processIdentifier,"window_id":window.windowNumber,"count":count,"value":field.stringValue,"pointer_changed":pointerChanged,"frontmost_changed":frontChanged,"clipboard_changed":clipboardChanged,"is_key":window.isKeyWindow,"ax_trusted":AXIsProcessTrusted(),"keyboard_focus_available":focus != nil,"keyboard_focus_changed":focusChanged,"scroll_y":scroll.contentView.bounds.origin.y,"checkpoint":lastCommand]
  if let data = try? JSONSerialization.data(withJSONObject:value,options:[.sortedKeys]) { try? data.write(to:URL(fileURLWithPath:output),options:.atomic) }
 }
}
let app=NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate=Probe()
app.delegate=delegate
app.run()
