# Jarvis Eyes — Windows visual-perception watcher.
#
# UNVERIFIED ON REAL WINDOWS HARDWARE: this script is written against
# documented, standard Win32 (SetWinEventHook) and .NET UI Automation
# (System.Windows.Automation) APIs, but this project's development
# environment is a headless Linux container with no Windows host to run
# PowerShell against. Review it as carefully-reasoned, standards-based
# code — not as something that has been executed and confirmed working.
# See COMPUTER_CONTROL.md / EYES.md for the full verification status.
#
# Architecture: this is a long-lived helper process, not a poll loop.
# SetWinEventHook registers OS-level callbacks that fire only when a real
# window/foreground/focus event happens; a Win32 message pump
# ([System.Windows.Forms.Application]::Run()) is required for those
# callbacks to actually be delivered — that pump is what "runs
# continuously" here, not a timer re-checking state. UI Automation event
# handlers (AddAutomationFocusChangedEventHandler,
# AddStructureChangedEventHandler) are equally event-driven, delivered by
# the same message pump.
#
# Protocol: newline-delimited JSON on stdout for both unsolicited events
# (`{"kind":"event",...}`) and responses to one-shot commands read from
# stdin (`{"kind":"response","id":...}`). One process serves both the
# continuous event stream and on-demand queries, so a query never pays
# the cost of spawning a fresh PowerShell process (unlike the one-shot
# `execFile` pattern used elsewhere in computer/*.ts, which is fine for
# infrequent actions but too slow for something meant to feel responsive).

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$win32 = @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class JarvisEyesWin32 {
    public delegate void WinEventDelegate(IntPtr hWinEventHook, uint eventType, IntPtr hwnd, int idObject, int idChild, uint dwEventThread, uint dwmsEventTime);

    [DllImport("user32.dll")]
    public static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr hmodWinEventProc, WinEventDelegate lpfnWinEventProc, uint idProcess, uint idThread, uint dwFlags);

    [DllImport("user32.dll")]
    public static extern bool UnhookWinEvent(IntPtr hWinEventHook);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    public const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
    public const uint EVENT_OBJECT_CREATE = 0x8000;
    public const uint EVENT_OBJECT_DESTROY = 0x8001;
    public const uint EVENT_OBJECT_FOCUS = 0x8005;
    public const uint EVENT_OBJECT_LOCATIONCHANGE = 0x800B;
    public const uint WINEVENT_OUTOFCONTEXT = 0x0000;
    public const uint WINEVENT_SKIPOWNPROCESS = 0x0002;
}
"@
Add-Type -TypeDefinition $win32 -Language CSharp

function Write-JsonLine($obj) {
    $json = $obj | ConvertTo-Json -Compress -Depth 10
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

function Get-ProcessNameSafe([uint32]$pid) {
    try { return (Get-Process -Id $pid -ErrorAction Stop).ProcessName } catch { return $null }
}

function Get-WindowSummary([IntPtr]$hwnd) {
    if ($hwnd -eq [IntPtr]::Zero) { return $null }
    $sb = New-Object System.Text.StringBuilder 512
    [JarvisEyesWin32]::GetWindowText($hwnd, $sb, 512) | Out-Null
    $title = $sb.ToString()
    $procId = 0
    [JarvisEyesWin32]::GetWindowThreadProcessId($hwnd, [ref]$procId) | Out-Null
    $rect = New-Object JarvisEyesWin32+RECT
    [JarvisEyesWin32]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
    $fg = [JarvisEyesWin32]::GetForegroundWindow()
    return @{
        windowId = $hwnd.ToString()
        processName = (Get-ProcessNameSafe $procId)
        title = $title
        isForeground = ($hwnd -eq $fg)
        boundingBox = @{ monitorId = "primary"; x = $rect.Left; y = $rect.Top; width = ($rect.Right - $rect.Left); height = ($rect.Bottom - $rect.Top) }
    }
}

# --- UI Automation tree walking -------------------------------------------

function ConvertTo-UiElementNode($element, [int]$depthRemaining) {
    if ($null -eq $element) { return $null }
    $current = $element.Current
    $patterns = @()
    try {
        foreach ($pi in $element.GetSupportedPatterns()) { $patterns += $pi.ProgrammaticName -replace 'PatternIdentifiers\.Pattern$', '' }
    } catch {}

    $rect = $current.BoundingRectangle
    $box = $null
    if (-not $rect.IsEmpty) {
        $box = @{ monitorId = "primary"; x = [int]$rect.X; y = [int]$rect.Y; width = [int]$rect.Width; height = [int]$rect.Height }
    }

    $refId = [guid]::NewGuid().ToString()
    $script:elementRefs[$refId] = $element

    $children = @()
    if ($depthRemaining -gt 0) {
        try {
            $childElements = $element.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
            foreach ($child in $childElements) {
                $children += (ConvertTo-UiElementNode $child ($depthRemaining - 1))
            }
        } catch {}
    }

    return @{
        automationId = $current.AutomationId
        name = $current.Name
        controlType = $current.ControlType.ProgrammaticName -replace 'ControlType\.', ''
        className = $current.ClassName
        processName = (Get-ProcessNameSafe $current.ProcessId)
        windowTitle = $null
        boundingBox = $box
        enabled = [bool]$current.IsEnabled
        focused = [bool]$current.HasKeyboardFocus
        patterns = $patterns
        elementRef = $refId
        children = $children
    }
}

$script:elementRefs = @{}

function Get-RootAutomationElement([string]$windowId) {
    if ([string]::IsNullOrEmpty($windowId)) {
        $hwnd = [JarvisEyesWin32]::GetForegroundWindow()
    } else {
        $hwnd = [IntPtr]([int64]$windowId)
    }
    return [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
}

# --- Command handling (one-shot queries over stdin) ------------------------

function Handle-Command($cmd) {
    try {
        switch ($cmd.cmd) {
            "list_windows" {
                $hwnds = @()
                [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
                    [System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition
                ) | ForEach-Object {
                    $h = [IntPtr]$_.Current.NativeWindowHandle
                    if ($h -ne [IntPtr]::Zero -and [JarvisEyesWin32]::IsWindowVisible($h)) {
                        $hwnds += (Get-WindowSummary $h)
                    }
                }
                return @{ id = $cmd.id; kind = "response"; ok = $true; data = $hwnds }
            }
            "get_ui_tree" {
                $root = Get-RootAutomationElement $cmd.windowId
                $maxDepth = if ($cmd.maxDepth) { [int]$cmd.maxDepth } else { 5 }
                $tree = ConvertTo-UiElementNode $root $maxDepth
                return @{ id = $cmd.id; kind = "response"; ok = $true; data = $tree }
            }
            "find_ui_element" {
                $root = Get-RootAutomationElement $cmd.windowId
                $conditions = New-Object System.Collections.Generic.List[System.Windows.Automation.Condition]
                if ($cmd.name) { $conditions.Add((New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $cmd.name))) }
                if ($cmd.automationId) { $conditions.Add((New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $cmd.automationId))) }
                if ($cmd.controlType) {
                    $ctField = [System.Windows.Automation.ControlType].GetField($cmd.controlType)
                    if ($ctField) { $conditions.Add((New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ctField.GetValue($null)))) }
                }
                $condition = if ($conditions.Count -gt 0) { New-Object System.Windows.Automation.AndCondition($conditions.ToArray()) } else { [System.Windows.Automation.Condition]::TrueCondition }
                $found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
                $results = @()
                foreach ($el in $found) { $results += (ConvertTo-UiElementNode $el 0) }
                return @{ id = $cmd.id; kind = "response"; ok = $true; data = $results }
            }
            "get_ui_element" {
                $el = $script:elementRefs[$cmd.elementRef]
                if (-not $el) { throw "Unknown elementRef (tree/query result may have expired — re-query first)." }
                # Depth 0: the caller already has this element's subtree from
                # whichever getUiTree/findUiElement call produced the ref;
                # this re-resolves just the element's own current
                # enabled/focused/value-ish state, not a full re-walk.
                $node = ConvertTo-UiElementNode $el 0
                return @{ id = $cmd.id; kind = "response"; ok = $true; data = $node }
            }
            "invoke_ui_element" {
                $el = $script:elementRefs[$cmd.elementRef]
                if (-not $el) { throw "Unknown elementRef (tree/query result may have expired — re-query first)." }
                $pattern = $null
                if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
                    $pattern.Invoke()
                } elseif ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) {
                    $pattern.Toggle()
                } elseif ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
                    $pattern.Select()
                } else {
                    throw "Element does not support Invoke, Toggle, or SelectionItem patterns."
                }
                return @{ id = $cmd.id; kind = "response"; ok = $true; data = @{ invoked = $true } }
            }
            "set_ui_value" {
                $el = $script:elementRefs[$cmd.elementRef]
                if (-not $el) { throw "Unknown elementRef (tree/query result may have expired — re-query first)." }
                $pattern = $null
                if (-not $el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
                    throw "Element does not support the Value pattern."
                }
                $pattern.SetValue($cmd.value)
                return @{ id = $cmd.id; kind = "response"; ok = $true; data = @{ set = $true } }
            }
            "focus_ui_element" {
                $el = $script:elementRefs[$cmd.elementRef]
                if (-not $el) { throw "Unknown elementRef (tree/query result may have expired — re-query first)." }
                $el.SetFocus()
                return @{ id = $cmd.id; kind = "response"; ok = $true; data = @{ focused = $true } }
            }
            "capture_frame" {
                # On-demand only — invoked exclusively in response to an
                # explicit request from the engine's AttentionManager or a
                # tool call, never on a timer. Uses GDI screen copy scoped
                # to the requested region (or the foreground window if
                # none given) — the same primitive as computer/screenshot.ts
                # but gated entirely differently: attention-triggered, not
                # polled, and only ever reachable through the Eyes
                # permission/allowlist gate.
                if ($cmd.region) {
                    $x = [int]$cmd.region.x; $y = [int]$cmd.region.y; $w = [int]$cmd.region.width; $h = [int]$cmd.region.height
                } else {
                    $hwnd = [JarvisEyesWin32]::GetForegroundWindow()
                    $rect = New-Object JarvisEyesWin32+RECT
                    [JarvisEyesWin32]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
                    $x = $rect.Left; $y = $rect.Top; $w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
                }
                $bmp = New-Object System.Drawing.Bitmap $w, $h
                $g = [System.Drawing.Graphics]::FromImage($bmp)
                $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size $w, $h))
                $ms = New-Object System.IO.MemoryStream
                $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
                $b64 = [Convert]::ToBase64String($ms.ToArray())
                $g.Dispose(); $bmp.Dispose(); $ms.Dispose()
                return @{ id = $cmd.id; kind = "response"; ok = $true; data = @{ mimeType = "image/png"; base64 = $b64; region = @{ monitorId = "primary"; x = $x; y = $y; width = $w; height = $h } } }
            }
            "exit" {
                return @{ id = $cmd.id; kind = "response"; ok = $true; data = @{ exiting = $true } }
            }
            default {
                return @{ id = $cmd.id; kind = "response"; ok = $false; error = "Unknown command: $($cmd.cmd)" }
            }
        }
    } catch {
        return @{ id = $cmd.id; kind = "response"; ok = $false; error = $_.Exception.Message }
    }
}

# --- Event wiring -----------------------------------------------------------

$winEventCallback = {
    param($hWinEventHook, $eventType, $hwnd, $idObject, $idChild, $dwEventThread, $dwmsEventTime)
    try {
        $win = Get-WindowSummary $hwnd
        $type = switch ($eventType) {
            ([JarvisEyesWin32]::EVENT_SYSTEM_FOREGROUND) { "window_focus_changed" }
            ([JarvisEyesWin32]::EVENT_OBJECT_CREATE)      { "window_created" }
            ([JarvisEyesWin32]::EVENT_OBJECT_DESTROY)     { "window_destroyed" }
            ([JarvisEyesWin32]::EVENT_OBJECT_LOCATIONCHANGE) { "window_moved_or_resized" }
            default { $null }
        }
        if ($type -and $win) {
            Write-JsonLine @{ kind = "event"; type = $type; window = $win }
        }
    } catch {}
}
$delegate = [JarvisEyesWin32+WinEventDelegate]$winEventCallback

$hooks = @()
$hooks += [JarvisEyesWin32]::SetWinEventHook([JarvisEyesWin32]::EVENT_SYSTEM_FOREGROUND, [JarvisEyesWin32]::EVENT_SYSTEM_FOREGROUND, [IntPtr]::Zero, $delegate, 0, 0, [JarvisEyesWin32]::WINEVENT_OUTOFCONTEXT)
$hooks += [JarvisEyesWin32]::SetWinEventHook([JarvisEyesWin32]::EVENT_OBJECT_CREATE, [JarvisEyesWin32]::EVENT_OBJECT_DESTROY, [IntPtr]::Zero, $delegate, 0, 0, [JarvisEyesWin32]::WINEVENT_OUTOFCONTEXT)
$hooks += [JarvisEyesWin32]::SetWinEventHook([JarvisEyesWin32]::EVENT_OBJECT_LOCATIONCHANGE, [JarvisEyesWin32]::EVENT_OBJECT_LOCATIONCHANGE, [IntPtr]::Zero, $delegate, 0, 0, [JarvisEyesWin32]::WINEVENT_OUTOFCONTEXT)

# UI Automation focus-changed events (event-driven, not polled).
$focusHandler = [System.Windows.Automation.AutomationFocusChangedEventHandler]{
    param($sender, $e)
    try {
        $el = $sender -as [System.Windows.Automation.AutomationElement]
        if ($el) {
            Write-JsonLine @{
                kind = "event"
                type = "ui_focus_changed"
                summary = "Focus moved to $($el.Current.ControlType.ProgrammaticName -replace 'ControlType\.','') '$($el.Current.Name)'"
            }
        }
    } catch {}
}
[System.Windows.Automation.Automation]::AddAutomationFocusChangedEventHandler($focusHandler)

Write-JsonLine @{ kind = "ready" }

# --- Main loop: pump Win32 messages (delivers WinEventHook callbacks) while
# also reading one-shot commands from stdin. Commands are read via a
# System.Windows.Forms.Timer tick on this same thread rather than a
# background thread, because UI Automation is STA/COM-affine — a second
# thread calling into AutomationElement would risk cross-thread COM
# failures. The timer tick is not "polling" in the sense this project
# avoids elsewhere: it drains whatever command lines are already buffered
# on stdin (non-blocking `Peek()`) — the actual events this whole script
# exists to observe (window/focus/structure changes) still arrive purely
# via the WinEventHook/UI-Automation callbacks above, not this timer.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 50
$timer.Add_Tick({
    while ([System.Console]::In.Peek() -ge 0) {
        $line = [System.Console]::In.ReadLine()
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try {
            $cmd = $line | ConvertFrom-Json
            $response = Handle-Command $cmd
            Write-JsonLine $response
            if ($cmd.cmd -eq "exit") { [System.Windows.Forms.Application]::Exit() }
        } catch {
            Write-JsonLine @{ kind = "response"; ok = $false; error = $_.Exception.Message }
        }
    }
})
$timer.Start()

[System.Windows.Forms.Application]::Run()

foreach ($h in $hooks) { [JarvisEyesWin32]::UnhookWinEvent($h) | Out-Null }
[System.Windows.Automation.Automation]::RemoveAllEventHandlers()
