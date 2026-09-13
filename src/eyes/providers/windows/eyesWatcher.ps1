# Jarvis Eyes — Windows visual-perception watcher.
#
# UNVERIFIED ON REAL WINDOWS HARDWARE: this script is written against
# documented, standard Windows APIs, but this project's development
# environment is a headless Linux container with no Windows host to run
# PowerShell against. Review it as carefully-reasoned, standards-based
# code — not as something that has been executed and confirmed working.
# See COMPUTER_CONTROL.md / EYES.md for the full verification status.
#
# TWO VERY DIFFERENT RISK TIERS IN THIS FILE, be aware which you're
# reading:
#  - The WinEventHook + UI Automation section (below) uses simple, flat
#    P/Invoke signatures — each a single function call with a handful of
#    primitive parameters. This is low-risk, common interop, and the kind
#    of Windows code this project has shipped with confidence throughout.
#  - The DXGI Desktop Duplication section (search for "CONTINUOUS VISUAL
#    CAPTURE" below) hand-declares COM interfaces via vtable-ordered
#    method lists (`[ComImport]`). This is categorically higher risk: a
#    single wrong slot position or ABI mismatch causes undefined behavior
#    (a crash or memory corruption) at the exact call site, not a clean
#    compile or runtime error pointing at the mistake. It is written as
#    carefully and completely as documented Windows SDK knowledge allows,
#    but it has never been compiled, let alone executed, on a real
#    Windows machine with a real GPU. Treat it as the single
#    highest-risk piece of native code in this entire codebase, validate
#    it against current Windows SDK headers on real hardware before
#    relying on it, and consider replacing it with a maintained interop
#    library (e.g. Vortice.Windows) if you need this to be production-
#    solid rather than a best-effort starting point.
#
# Architecture: this is a long-lived helper process, not a poll loop, for
# EVERY capability it exposes — including continuous visual capture:
#  - SetWinEventHook registers OS-level callbacks that fire only when a
#    real window/foreground/focus event happens; a Win32 message pump
#    ([System.Windows.Forms.Application]::Run()) is required for those
#    callbacks to actually be delivered — that pump is what "runs
#    continuously" here, not a timer re-checking state. UI Automation
#    event handlers are equally event-driven, delivered by the same pump.
#  - Continuous visual capture uses DXGI Desktop Duplication's
#    AcquireNextFrame, which BLOCKS (with a timeout) until the GPU
#    actually has a new frame — not a `sleep(N); grab pixels` loop. It
#    runs on its own dedicated background thread so it can never stall,
#    or be stalled by, the message-pump thread above.
#
# Protocol: newline-delimited JSON on stdout for unsolicited events
# (`{"kind":"event",...}`), unsolicited continuous-capture ticks
# (`{"kind":"frame",...}`), and responses to one-shot commands read from
# stdin (`{"kind":"response","id":...}`). One process serves all three, so
# a query never pays the cost of spawning a fresh PowerShell process
# (unlike the one-shot `execFile` pattern used elsewhere in
# computer/*.ts, which is fine for infrequent actions but too slow for
# something meant to feel responsive). Two threads write to stdout (the
# main message-pump thread, and the capture thread) — `Write-JsonLine`
# below is lock-protected so their output can never interleave into
# corrupted JSON lines.

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

# =============================================================================
# CONTINUOUS VISUAL CAPTURE (DXGI Desktop Duplication)
# =============================================================================
#
# See this file's header for the risk-tier warning about this section
# specifically — it is COM-vtable interop, not the flat P/Invoke used
# above, and is unverified against real hardware.
#
# Design choices worth stating explicitly:
#  - Every COM interface below declares vtable slots in the REAL, documented
#    Windows SDK order (IUnknown's 3 slots are implicit via
#    InterfaceIsIUnknown; inherited-interface slots come first, then the
#    interface's own methods, in header order). Getting an order wrong
#    would silently call the WRONG method at runtime — this is the actual
#    danger zone.
#  - Slots this code never calls are declared as trivial zero-argument
#    placeholders (`UnusedN()`) rather than fully-modeled real signatures.
#    This is safe specifically BECAUSE they're never invoked: a vtable
#    slot's declared .NET signature only has to be correct for slots that
#    are actually called through — earlier/later slots just need to exist
#    in the right position to keep everything after them correctly
#    aligned. Only ~10 methods across all interfaces are actually invoked
#    and are given complete, real signatures: EnumAdapters1, EnumOutputs,
#    DuplicateOutput, AcquireNextFrame, GetFrameDirtyRects, ReleaseFrame,
#    CreateTexture2D, Map, Unmap, CopyResource.
#  - D3D11CreateDevice's own out-parameter hands back the immediate
#    device context directly, so ID3D11Device never needs a
#    GetImmediateContext call (or its vtable slot) at all.
#  - Everything reads back through ID3D11DeviceContext.CopyResource into a
#    CPU-readable STAGING texture, then Map/Unmap — the standard, correct
#    pattern (this is what Microsoft's own Desktop Duplication sample
#    does). IDXGIOutputDuplication.MapDesktopSurface looks like a
#    shortcut but is well known to fail on most modern WDDM 2.0 drivers,
#    so it is deliberately not used here.
#  - All resource pointers are carried as raw IntPtr end to end (no typed
#    ID3D11Texture2D/ID3D11Resource wrapper interface exists at all) —
#    CopyResource's parameters are declared as IntPtr, so a raw COM
#    pointer from CreateTexture2D or QueryInterface can be passed directly.
#  - Runs on its own dedicated background thread (MTA), separate from the
#    STA thread hosting the Win32/UI-Automation message pump, so neither
#    can ever block the other. It writes directly to stdout using the
#    same lock `Write-JsonLine` uses (exposed as a static field) rather
#    than calling back into a PowerShell scriptblock from a foreign
#    thread, which is not a reliably supported pattern.
#  - Never a fallback: if DXGI/D3D11 initialization fails for any reason
#    (no GPU adapter, an unsupported session, a driver that refuses
#    duplication), `Start` returns false and the caller reports
#    continuous capture as unavailable — it never substitutes a
#    screenshot-polling loop.
$dxgiCapture = @"
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Text;

public static class JarvisEyesCapture
{
    public static readonly object StdoutLock = new object();

    // ---- Plain DLL exports (function-pointer P/Invoke, NOT vtable calls —
    // the low-risk kind, same category as the Win32 calls above) ----------
    [DllImport("dxgi.dll")]
    private static extern int CreateDXGIFactory1(ref Guid riid, out IntPtr ppFactory);

    [DllImport("d3d11.dll")]
    private static extern int D3D11CreateDevice(
        IntPtr pAdapter, uint DriverType, IntPtr Software, uint Flags,
        IntPtr pFeatureLevels, uint FeatureLevels, uint SDKVersion,
        out IntPtr ppDevice, out int pFeatureLevel, out IntPtr ppImmediateContext);

    private static readonly Guid IID_IDXGIFactory1 = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
    private static readonly Guid IID_IDXGIOutput1 = new Guid("00cddea8-939b-4b83-a340-a685226666cc");

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct DXGI_OUTDUPL_POINTER_POSITION { public POINT Position; public int Visible; }

    [StructLayout(LayoutKind.Sequential)]
    private struct DXGI_OUTDUPL_FRAME_INFO
    {
        public long LastPresentTime;
        public long LastMouseUpdateTime;
        public uint AccumulatedFrames;
        public int RectsCoalesced;
        public int ProtectedContentMaskedOut;
        public DXGI_OUTDUPL_POINTER_POSITION PointerPosition;
        public uint TotalMetadataBufferSize;
        public uint PointerShapeBufferSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct DXGI_SAMPLE_DESC { public uint Count; public uint Quality; }

    [StructLayout(LayoutKind.Sequential)]
    private struct D3D11_TEXTURE2D_DESC
    {
        public uint Width;
        public uint Height;
        public uint MipLevels;
        public uint ArraySize;
        public uint Format;
        public DXGI_SAMPLE_DESC SampleDesc;
        public uint Usage;
        public uint BindFlags;
        public uint CPUAccessFlags;
        public uint MiscFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct D3D11_MAPPED_SUBRESOURCE { public IntPtr pData; public uint RowPitch; public uint DepthPitch; }

    private const uint DXGI_FORMAT_B8G8R8A8_UNORM = 87; // Desktop Duplication always hands back this format
    private const uint D3D11_USAGE_STAGING = 3;
    private const uint D3D11_CPU_ACCESS_READ = 0x20000;
    private const uint D3D11_MAP_READ = 1;
    private const int DXGI_ERROR_WAIT_TIMEOUT = unchecked((int)0x887A0027);

    // IDXGIFactory1 — need EnumAdapters1 at absolute vtable slot 7
    // (IDXGIObject: 0-3, IDXGIFactory: EnumAdapters=4, MakeWindowAssociation=5,
    // GetWindowAssociation=6 ... wait, need CreateSwapChain=7,
    // CreateSoftwareAdapter=8 too before EnumAdapters1=9, IsCurrent=10).
    [ComImport, Guid("770aae78-f26f-4dba-a829-253c83d1b387"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IDXGIFactory1
    {
        void Unused0(); void Unused1(); void Unused2(); void Unused3(); // IDXGIObject
        void Unused4(); // EnumAdapters
        void Unused5(); // MakeWindowAssociation
        void Unused6(); // GetWindowAssociation
        void Unused7(); // CreateSwapChain
        void Unused8(); // CreateSoftwareAdapter
        int EnumAdapters1(uint Adapter, out IntPtr ppAdapter); // slot 9
    }

    [ComImport, Guid("29038f61-3839-4626-91fd-086879011a05"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IDXGIAdapter1
    {
        void Unused0(); void Unused1(); void Unused2(); void Unused3(); // IDXGIObject
        int EnumOutputs(uint Output, out IntPtr ppOutput); // slot 4
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DXGI_OUTPUT_DESC
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
        public RECT DesktopCoordinates;
        public int AttachedToDesktop;
        public uint Rotation;
        public IntPtr Monitor;
    }

    [ComImport, Guid("00cddea8-939b-4b83-a340-a685226666cc"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IDXGIOutput1
    {
        void Unused0(); void Unused1(); void Unused2(); void Unused3(); // IDXGIObject
        int GetDesc(out DXGI_OUTPUT_DESC pDesc); // slot 4 — real desktop dimensions, NOT assumed; returns HRESULT
        void Unused5(); void Unused6(); void Unused7(); void Unused8(); void Unused9(); // rest of IDXGIOutput
        void Unused10(); void Unused11(); void Unused12(); void Unused13(); void Unused14(); void Unused15();
        void Unused16(); void Unused17(); void Unused18(); // IDXGIOutput1's own GetDisplayModeList1/FindClosestMatchingMode1/GetDisplaySurfaceData1
        int DuplicateOutput(IntPtr pDevice, out IntPtr ppOutputDuplication); // slot 19
    }

    [ComImport, Guid("191cfac3-a341-470d-b26e-a864f428319c"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IDXGIOutputDuplication
    {
        void Unused0(); void Unused1(); void Unused2(); void Unused3(); // IDXGIObject
        void UnusedGetDesc(); // slot 4
        int AcquireNextFrame(uint TimeoutInMilliseconds, out DXGI_OUTDUPL_FRAME_INFO pFrameInfo, out IntPtr ppDesktopResource); // slot 5
        int GetFrameDirtyRects(uint DirtyRectsBufferSize, [Out] RECT[] pDirtyRectsBuffer, out uint pDirtyRectsBufferSizeRequired); // slot 6
        void UnusedGetFrameMoveRects(); // slot 7
        void UnusedGetFramePointerShape(); // slot 8
        void UnusedMapDesktopSurface(); // slot 9 — deliberately unused; see file header
        void UnusedUnMapDesktopSurface(); // slot 10
        int ReleaseFrame(); // slot 11
    }

    [ComImport, Guid("db6f6ddb-ac77-4e88-8253-819df9bbf140"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ID3D11Device
    {
        void Unused0(); // CreateBuffer
        void Unused1(); // CreateTexture1D
        int CreateTexture2D(ref D3D11_TEXTURE2D_DESC pDesc, IntPtr pInitialData, out IntPtr ppTexture2D); // slot 2
    }

    [ComImport, Guid("c0bfa96c-e089-44fb-8eaf-26f8796190da"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ID3D11DeviceContext
    {
        void Unused0(); void Unused1(); void Unused2(); void Unused3(); // ID3D11DeviceChild
        void Unused4(); void Unused5(); void Unused6(); void Unused7(); void Unused8(); void Unused9(); void Unused10(); // through DrawIndexed(9)/Draw(10)... approx
        int Map(IntPtr pResource, uint Subresource, uint MapType, uint MapFlags, out D3D11_MAPPED_SUBRESOURCE pMappedResource); // slot 11
        void Unmap(IntPtr pResource, uint Subresource); // slot 12
        void Unused13(); void Unused14(); void Unused15(); void Unused16(); void Unused17(); void Unused18(); void Unused19();
        void Unused20(); void Unused21(); void Unused22(); void Unused23(); void Unused24(); void Unused25(); void Unused26();
        void Unused27(); void Unused28(); void Unused29(); void Unused30(); void Unused31(); void Unused32(); void Unused33();
        void Unused34(); void Unused35(); void Unused36(); void Unused37(); void Unused38(); void Unused39(); void Unused40();
        void Unused41(); void Unused42(); void Unused43(); // through RSSetScissorRects(43)
        void UnusedCopySubresourceRegion(); // slot 44
        void CopyResource(IntPtr pDstResource, IntPtr pSrcResource); // slot 45
    }

    // ---- Capture loop state ----------------------------------------------
    private static Thread _thread;
    private static volatile bool _running;
    private static long _sequence;

    public static bool Start(int displayIndex, int captureFps, int processingFps, int maxBufferedFrames)
    {
        if (_running) return true;
        _running = true;
        _sequence = 0;

        var ready = new ManualResetEventSlim(false);
        bool initOk = false;
        Exception initError = null;

        _thread = new Thread(() =>
        {
            try
            {
                RunCaptureLoop(displayIndex, captureFps, processingFps, ref initOk, ref initError, ready);
            }
            catch (Exception ex)
            {
                initError = ex;
                initOk = false;
                if (!ready.IsSet) ready.Set();
            }
            finally
            {
                _running = false;
            }
        });
        _thread.IsBackground = true;
        _thread.SetApartmentState(ApartmentState.MTA); // DXGI/D3D11 are free-threaded; deliberately NOT the UI Automation STA thread
        _thread.Start();

        ready.Wait(10000);
        if (!initOk)
        {
            _running = false;
            if (initError != null) throw initError;
            throw new InvalidOperationException("Continuous capture did not initialize within 10s.");
        }
        return true;
    }

    public static void Stop()
    {
        _running = false;
        _thread?.Join(2000);
    }

    private static void RunCaptureLoop(int displayIndex, int captureFps, int processingFps, ref bool initOk, ref Exception initError, ManualResetEventSlim ready)
    {
        IntPtr factoryPtr = IntPtr.Zero, adapterPtr = IntPtr.Zero, outputPtr = IntPtr.Zero, output1Ptr = IntPtr.Zero;
        IntPtr devicePtr = IntPtr.Zero, contextPtr = IntPtr.Zero, dupPtr = IntPtr.Zero, stagingPtr = IntPtr.Zero;
        object device = null, context = null, duplication = null;
        uint width = 0, height = 0;
        long lastMaterializedMs = 0;

        try
        {
            var factoryIid = IID_IDXGIFactory1;
            int hr = CreateDXGIFactory1(ref factoryIid, out factoryPtr);
            if (hr < 0) throw new InvalidOperationException("CreateDXGIFactory1 failed: 0x" + hr.ToString("X8"));
            var factory = (IDXGIFactory1)Marshal.GetTypedObjectForIUnknown(factoryPtr, typeof(IDXGIFactory1));

            hr = factory.EnumAdapters1((uint)0, out adapterPtr); // TODO: adapter selection for true multi-GPU setups is not implemented — primary adapter only
            if (hr < 0) throw new InvalidOperationException("EnumAdapters1 failed: 0x" + hr.ToString("X8"));
            var adapter = (IDXGIAdapter1)Marshal.GetTypedObjectForIUnknown(adapterPtr, typeof(IDXGIAdapter1));

            hr = adapter.EnumOutputs((uint)Math.Max(0, displayIndex), out outputPtr);
            if (hr < 0) throw new InvalidOperationException("EnumOutputs(" + displayIndex + ") failed: 0x" + hr.ToString("X8") + " — display index may not exist");

            var output1Iid = IID_IDXGIOutput1;
            hr = Marshal.QueryInterface(outputPtr, ref output1Iid, out output1Ptr);
            if (hr < 0) throw new InvalidOperationException("QueryInterface(IDXGIOutput1) failed: 0x" + hr.ToString("X8"));
            var output1 = (IDXGIOutput1)Marshal.GetTypedObjectForIUnknown(output1Ptr, typeof(IDXGIOutput1));

            int featureLevel;
            hr = D3D11CreateDevice(adapterPtr, /* D3D_DRIVER_TYPE_UNKNOWN */ 0, IntPtr.Zero, 0, IntPtr.Zero, 0, 7, out devicePtr, out featureLevel, out contextPtr);
            if (hr < 0) throw new InvalidOperationException("D3D11CreateDevice failed: 0x" + hr.ToString("X8"));
            device = Marshal.GetTypedObjectForIUnknown(devicePtr, typeof(ID3D11Device));
            context = Marshal.GetTypedObjectForIUnknown(contextPtr, typeof(ID3D11DeviceContext));

            hr = output1.DuplicateOutput(devicePtr, out dupPtr);
            if (hr < 0) throw new InvalidOperationException("DuplicateOutput failed: 0x" + hr.ToString("X8") + " — often means no GPU adapter, a remote/console session without duplication support, or another process already holding exclusive duplication");
            duplication = Marshal.GetTypedObjectForIUnknown(dupPtr, typeof(IDXGIOutputDuplication));

            // Real desktop dimensions — required for the staging texture to
            // match the duplicated resource's actual size. Getting this
            // wrong (e.g. an assumed/hard-coded resolution) would make
            // every CopyResource call below operate on mismatched-size
            // resources, which D3D11 does not define as safe.
            DXGI_OUTPUT_DESC outputDesc;
            hr = output1.GetDesc(out outputDesc);
            if (hr < 0) throw new InvalidOperationException("IDXGIOutput1.GetDesc failed: 0x" + hr.ToString("X8"));
            width = (uint)(outputDesc.DesktopCoordinates.Right - outputDesc.DesktopCoordinates.Left);
            height = (uint)(outputDesc.DesktopCoordinates.Bottom - outputDesc.DesktopCoordinates.Top);
            if (width == 0 || height == 0) throw new InvalidOperationException("IDXGIOutput1.GetDesc returned an empty desktop rectangle.");

            var stagingDesc = new D3D11_TEXTURE2D_DESC
            {
                Width = width, Height = height, MipLevels = 1, ArraySize = 1,
                Format = DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc = new DXGI_SAMPLE_DESC { Count = 1, Quality = 0 },
                Usage = D3D11_USAGE_STAGING, BindFlags = 0, CPUAccessFlags = D3D11_CPU_ACCESS_READ, MiscFlags = 0,
            };
            hr = ((ID3D11Device)device).CreateTexture2D(ref stagingDesc, IntPtr.Zero, out stagingPtr);
            if (hr < 0) throw new InvalidOperationException("CreateTexture2D (staging) failed: 0x" + hr.ToString("X8"));

            initOk = true;
            ready.Set();
        }
        catch (Exception ex)
        {
            initError = ex;
            initOk = false;
            ready.Set();
            ReleaseAll(factoryPtr, adapterPtr, outputPtr, output1Ptr, devicePtr, contextPtr, dupPtr, stagingPtr);
            return;
        }

        var dup = (IDXGIOutputDuplication)duplication;
        var ctx = (ID3D11DeviceContext)context;
        uint timeoutMs = (uint)Math.Max(1, 1000 / Math.Max(1, captureFps));
        double minMaterializeIntervalMs = processingFps > 0 ? 1000.0 / processingFps : double.PositiveInfinity;
        var stopwatch = System.Diagnostics.Stopwatch.StartNew();

        while (_running)
        {
            DXGI_OUTDUPL_FRAME_INFO frameInfo;
            IntPtr desktopResourcePtr;
            int hr = dup.AcquireNextFrame(timeoutMs, out frameInfo, out desktopResourcePtr);
            if (hr == DXGI_ERROR_WAIT_TIMEOUT) continue; // no new frame within the timeout — not an error, just try again
            if (hr < 0)
            {
                // Session lost (e.g. display mode change, lock screen, GPU
                // driver reset) — stop rather than spin on a broken
                // duplication handle. KNOWN GAP: this notifies no one — the
                // Node side has no signal that continuous capture silently
                // died mid-session and will believe it is still active
                // until the next explicit stop/start. A production-hardened
                // version should emit a `{"kind":"frame_stream_closed"}`
                // message here and have the engine treat it as a cue to
                // retry startContinuousCapture rather than relying on a
                // user-initiated settings change to notice.
                break;
            }

            try
            {
                RECT[] dirty = new RECT[64];
                uint dirtyNeeded;
                int dirtyHr = dup.GetFrameDirtyRects((uint)(dirty.Length * Marshal.SizeOf(typeof(RECT))), dirty, out dirtyNeeded);
                int dirtyCount = dirtyHr >= 0 ? (int)(dirtyNeeded / Marshal.SizeOf(typeof(RECT))) : 0;

                long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                double changeScore = Math.Min(1.0, dirtyCount / 8.0); // coarse coverage proxy — see file note above on real dirty-rect area
                bool dueByRate = (nowMs - lastMaterializedMs) >= minMaterializeIntervalMs;
                bool dueBySignificance = changeScore >= 0.6;
                bool materialize = dirtyCount > 0 && (dueByRate || dueBySignificance);

                string pixelsJson = "null";
                if (materialize)
                {
                    ctx.CopyResource(stagingPtr, desktopResourcePtr);
                    D3D11_MAPPED_SUBRESOURCE mapped;
                    int mapHr = ctx.Map(stagingPtr, 0, D3D11_MAP_READ, 0, out mapped);
                    if (mapHr >= 0)
                    {
                        try
                        {
                            pixelsJson = EncodeJpegBase64(mapped, (int)width, (int)height);
                            lastMaterializedMs = nowMs;
                        }
                        finally
                        {
                            ctx.Unmap(stagingPtr, 0);
                        }
                    }
                }

                var json = new StringBuilder(256);
                json.Append("{\"kind\":\"frame\",\"sequence\":").Append(Interlocked.Increment(ref _sequence));
                json.Append(",\"atMs\":").Append(nowMs);
                json.Append(",\"displayId\":\"").Append(displayIndex).Append("\"");
                json.Append(",\"width\":").Append(width).Append(",\"height\":").Append(height);
                json.Append(",\"changeScore\":").Append(changeScore.ToString("0.###"));
                json.Append(",\"changedRegions\":[");
                for (int i = 0; i < dirtyCount && i < dirty.Length; i++)
                {
                    if (i > 0) json.Append(",");
                    var r = dirty[i];
                    json.Append("{\"monitorId\":\"").Append(displayIndex).Append("\",\"x\":").Append(r.Left)
                        .Append(",\"y\":").Append(r.Top).Append(",\"width\":").Append(r.Right - r.Left)
                        .Append(",\"height\":").Append(r.Bottom - r.Top).Append("}");
                }
                json.Append("]");
                if (pixelsJson == "null") json.Append(",\"pixels\":null");
                else json.Append(",\"pixels\":").Append(pixelsJson);
                json.Append("}");

                Monitor.Enter(StdoutLock);
                try { Console.Out.WriteLine(json.ToString()); Console.Out.Flush(); }
                finally { Monitor.Exit(StdoutLock); }
            }
            finally
            {
                dup.ReleaseFrame();
                if (desktopResourcePtr != IntPtr.Zero) Marshal.Release(desktopResourcePtr);
            }
        }

        ReleaseAll(factoryPtr, adapterPtr, outputPtr, output1Ptr, devicePtr, contextPtr, dupPtr, stagingPtr);
    }

    private static string EncodeJpegBase64(D3D11_MAPPED_SUBRESOURCE mapped, int width, int height)
    {
        // BGRA8 staging texture -> GDI+ Bitmap -> JPEG. LockBits with the
        // texture's own RowPitch (which can exceed width*4 due to GPU
        // alignment) rather than assuming a tightly-packed buffer.
        var bmp = new Bitmap(width, height, PixelFormat.Format32bppArgb);
        var rect = new Rectangle(0, 0, width, height);
        var bmpData = bmp.LockBits(rect, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
        try
        {
            for (int y = 0; y < height; y++)
            {
                IntPtr srcRow = IntPtr.Add(mapped.pData, y * (int)mapped.RowPitch);
                IntPtr dstRow = IntPtr.Add(bmpData.Scan0, y * bmpData.Stride);
                // Copy via an intermediate managed buffer — Windows has no
                // direct pointer-to-pointer RtlMoveMemory P/Invoke declared
                // here, and this keeps the copy allocation-bounded per row.
                byte[] rowBuf = new byte[Math.Min((int)mapped.RowPitch, bmpData.Stride)];
                Marshal.Copy(srcRow, rowBuf, 0, rowBuf.Length);
                Marshal.Copy(rowBuf, 0, dstRow, rowBuf.Length);
            }
        }
        finally
        {
            bmp.UnlockBits(bmpData);
        }

        using (var ms = new MemoryStream())
        {
            var jpegCodec = GetJpegCodec();
            var encParams = new EncoderParameters(1);
            encParams.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 65L); // bounded size over fidelity — this is local memory, not a permanent record
            if (jpegCodec != null) bmp.Save(ms, jpegCodec, encParams);
            else bmp.Save(ms, ImageFormat.Jpeg);
            bmp.Dispose();
            string b64 = Convert.ToBase64String(ms.ToArray());
            return "{\"mimeType\":\"image/jpeg\",\"base64\":\"" + b64 + "\"}";
        }
    }

    private static ImageCodecInfo GetJpegCodec()
    {
        foreach (var codec in ImageCodecInfo.GetImageEncoders())
            if (codec.FormatID == ImageFormat.Jpeg.Guid) return codec;
        return null;
    }

    private static void ReleaseAll(params IntPtr[] ptrs)
    {
        foreach (var p in ptrs)
        {
            if (p != IntPtr.Zero) { try { Marshal.Release(p); } catch { } }
        }
    }
}
"@
Add-Type -TypeDefinition $dxgiCapture -Language CSharp -ReferencedAssemblies System.Drawing.dll

function Write-JsonLine($obj) {
    $json = $obj | ConvertTo-Json -Compress -Depth 10
    # The continuous-capture thread and this (main) thread both write to
    # stdout; without this shared lock (the same one the capture thread
    # uses) their output could interleave mid-line and corrupt the
    # newline-JSON protocol on the Node side.
    [System.Threading.Monitor]::Enter([JarvisEyesCapture]::StdoutLock)
    try {
        [Console]::Out.WriteLine($json)
        [Console]::Out.Flush()
    } finally {
        [System.Threading.Monitor]::Exit([JarvisEyesCapture]::StdoutLock)
    }
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
            "start_continuous_capture" {
                # displayId arrives as a string (e.g. "0"); default to the
                # primary display (index 0) when omitted or non-numeric.
                $displayIndex = 0
                if ($cmd.displayId) { [void][int]::TryParse([string]$cmd.displayId, [ref]$displayIndex) }
                $captureFps = if ($cmd.captureFps) { [int]$cmd.captureFps } else { 10 }
                $processingFps = if ($cmd.processingFps) { [int]$cmd.processingFps } else { 2 }
                $maxBufferedFrames = if ($cmd.maxBufferedFrames) { [int]$cmd.maxBufferedFrames } else { 90 }
                # Throws with a specific, actionable message on failure
                # (no GPU adapter, unsupported session, etc.) — the caller
                # (Handle-Command's own try/catch) turns that into an
                # honest ok:$false response rather than a fake success.
                [JarvisEyesCapture]::Start($displayIndex, $captureFps, $processingFps, $maxBufferedFrames) | Out-Null
                return @{ id = $cmd.id; kind = "response"; ok = $true; data = @{ started = $true } }
            }
            "stop_continuous_capture" {
                [JarvisEyesCapture]::Stop()
                return @{ id = $cmd.id; kind = "response"; ok = $true; data = @{ stopped = $true } }
            }
            "exit" {
                [JarvisEyesCapture]::Stop()
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
[JarvisEyesCapture]::Stop()
