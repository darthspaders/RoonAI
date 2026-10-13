// Owned SoundSpectrum HLS capture. GPU textures stay on one D3D11 device.
// Protocol1: bounded private stdin configuration; stdout contains safe counters only.
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <tlhelp32.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <cstdio>
#include <cstdlib>
#include <cwchar>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_set>
#include <algorithm>
#include <atomic>
#include <thread>
#include <set>
#include <cmath>
#include <winrt/Windows.Data.Json.h>
#include <gst/gst.h>
#include <gst/app/gstappsrc.h>
#include <gst/video/video.h>
#include <gst/d3d11/gstd3d11.h>

// Official Microsoft WinRT ABI; installed SDK19041 predates this interface.
// microsoft/win32metadata/.../winrt/windows.graphics.capture.h Session5:
// IID67c0ea62-1f85-5061-925a-239be0ac09cb, IInspectable then get/put TimeSpan.
struct RHTimeSpan { INT64 Duration; };
MIDL_INTERFACE("67c0ea62-1f85-5061-925a-239be0ac09cb")
RHGraphicsCaptureSession5 : public IInspectable {
  virtual HRESULT STDMETHODCALLTYPE get_MinUpdateInterval(RHTimeSpan*) = 0;
  virtual HRESULT STDMETHODCALLTYPE put_MinUpdateInterval(RHTimeSpan) = 0;
};
static_assert(sizeof(RHTimeSpan) == 8, "Official TimeSpan ABI size");

using namespace winrt;
using namespace winrt::Windows::Graphics;
using namespace winrt::Windows::Graphics::Capture;
using namespace winrt::Windows::Graphics::DirectX;
using namespace winrt::Windows::Graphics::DirectX::Direct3D11;

static LONGLONG frequency;
static LONGLONG ticks() { LARGE_INTEGER x; QueryPerformanceCounter(&x); return x.QuadPart; }
static double elapsed_ms(LONGLONG a, LONGLONG b) { return (b-a)*1000.0/frequency; }

struct Target {
  HANDLE process=nullptr;
  HWND hwnd=nullptr;
  DWORD pid=0;
  HANDLE owner=nullptr;
  std::wstring expected_class,expected_title;
  ~Target() { if(process) CloseHandle(process); if(owner) CloseHandle(owner); }
  bool valid() const {
    if(!process || WaitForSingleObject(process,0)!=WAIT_TIMEOUT || !owner || WaitForSingleObject(owner,0)!=WAIT_TIMEOUT || !IsWindow(hwnd)) return false;
    DWORD actual=0; GetWindowThreadProcessId(hwnd,&actual);
    WCHAR cls[128]={}, title[256]={}; RECT rc={};
    return actual==pid && GetClassNameW(hwnd,cls,128) &&
      expected_class==cls && GetWindowTextW(hwnd,title,256) &&
      expected_title==title &&
      GetClientRect(hwnd,&rc) && rc.right-rc.left==3840 && rc.bottom-rc.top==2160 &&
      !IsIconic(hwnd);
  }
};
static bool owned_title(const wchar_t* text) {
  const std::wstring value=text ? text:L"";std::wstring prefix;
  for(const auto product:{L"WhiteCap",L"Aeon",L"G-Force"}) {const auto candidate=std::wstring(L"Rabbit Hole ")+product+L" RH-";if(value.compare(0,candidate.size(),candidate)==0){prefix=candidate;break;}}
  if(prefix.empty())return false;
  if(value.size()!=prefix.size()+36 || value.compare(0,prefix.size(),prefix)) return false;
  for(size_t i=0;i<36;i++) {
    const wchar_t ch=value[prefix.size()+i];
    if(i==8||i==13||i==18||i==23) { if(ch!=L'-') return false; }
    else if(!((ch>=L'0'&&ch<=L'9')||(ch>=L'a'&&ch<=L'f')||(ch>=L'A'&&ch<=L'F'))) return false;
  }
  return true;
}
static bool owned_lineage(DWORD owner_pid,DWORD target_pid) {
  HANDLE snapshot=CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS,0);
  if(snapshot==INVALID_HANDLE_VALUE) return false;
  PROCESSENTRY32W entry{};entry.dwSize=sizeof(entry);bool target=false,self=false;
  if(Process32FirstW(snapshot,&entry)) do {
    if(entry.th32ProcessID==target_pid) target=entry.th32ParentProcessID==owner_pid;
    if(entry.th32ProcessID==GetCurrentProcessId()) self=entry.th32ParentProcessID==owner_pid;
  } while(Process32NextW(snapshot,&entry));
  CloseHandle(snapshot);return target&&self;
}
static bool stop_requested() {
  HANDLE h=GetStdHandle(STD_INPUT_HANDLE); DWORD available=0;
  if(!h || h==INVALID_HANDLE_VALUE) return false;
  if(!PeekNamedPipe(h,nullptr,0,nullptr,&available,nullptr))
    return GetLastError()==ERROR_BROKEN_PIPE;
  if(!available) return false;
  char bytes[32]; DWORD read=0;
  return ReadFile(h,bytes,std::min<DWORD>(available,sizeof(bytes)),&read,nullptr) && read>0;
}
static unsigned long long parse_number(const wchar_t* v) {
  if(!v || !*v) throw hresult_error(E_INVALIDARG);
  for(const wchar_t* p=v;*p;p++) if(*p<L'0'||*p>L'9') throw hresult_error(E_INVALIDARG);
  wchar_t* end=nullptr; errno=0; const auto result=wcstoull(v,&end,10);
  if(errno || !end || *end) throw hresult_error(E_INVALIDARG);
  return result;
}

static constexpr const char* VERSION="hls-wgc-3";
struct Config {
  unsigned fps=60;
  DWORD owner_pid=0,native_pid=0;
  unsigned long long owner_ticks=0,native_ticks=0,hwnd=0;
  unsigned adapter=0,bitrate=0,port=0;
  std::wstring owner_exe,native_exe,title,window_class;
  std::string media,user,password;
};
static std::string read_config_line() {
  const auto started=ticks();std::string line;line.reserve(2048);auto input=GetStdHandle(STD_INPUT_HANDLE);
  if(!input||input==INVALID_HANDLE_VALUE)throw hresult_error(E_INVALIDARG);
  while(elapsed_ms(started,ticks())<5000) {
    DWORD available=0;if(!PeekNamedPipe(input,nullptr,0,nullptr,&available,nullptr))throw hresult_error(E_INVALIDARG);
    if(!available){Sleep(10);continue;}
    char value;DWORD received=0;if(!ReadFile(input,&value,1,&received,nullptr)||received!=1)throw hresult_error(E_INVALIDARG);
    if(value=='\n')return line;
    if(line.size()>=16384||value=='\0')throw hresult_error(E_INVALIDARG);line.push_back(value);
  }
  throw hresult_error(HRESULT_FROM_WIN32(ERROR_TIMEOUT));
}
static bool hex_token(const std::string& value) {
  return value.size()==32&&std::all_of(value.begin(),value.end(),[](char ch){return(ch>='0'&&ch<='9')||(ch>='a'&&ch<='f');});
}
static Config parse_config(const std::string& line) {
  using namespace winrt::Windows::Data::Json;
  const auto object=JsonObject::Parse(to_hstring(line));
  const std::set<std::wstring> allowed={L"protocol",L"ownerPid",L"ownerExecutable",L"ownerStartTimeTicks",L"nativePid",L"nativeExecutable",L"nativeStartTimeTicks",L"windowHandle",L"windowTitle",L"windowClass",L"adapterIndex",L"targetFps",L"bitrateMbps",L"rtmpPort",L"mediaPath",L"user",L"password"};
  if(object.Size()!=allowed.size())throw hresult_error(E_INVALIDARG);
  for(const auto& pair:object)if(!allowed.count(std::wstring(pair.Key())))throw hresult_error(E_INVALIDARG);
  const auto number=[&](const wchar_t* key,double lower,double upper){const auto value=object.GetNamedNumber(key);if(!std::isfinite(value)||std::floor(value)!=value||value<lower||value>upper)throw hresult_error(E_INVALIDARG);return(unsigned long long)value;};
  const auto string=[&](const wchar_t* key){const auto value=object.GetNamedString(key);if(value.size()>32767)throw hresult_error(E_INVALIDARG);for(const auto ch:value)if(ch<32||ch==127)throw hresult_error(E_INVALIDARG);return std::wstring(value);};
  if(number(L"protocol",1,1)!=1)throw hresult_error(E_INVALIDARG);
  Config c;c.fps=(unsigned)number(L"targetFps",60,120);if(c.fps!=60&&c.fps!=120)throw hresult_error(E_INVALIDARG);c.owner_pid=(DWORD)number(L"ownerPid",1,MAXDWORD);c.native_pid=(DWORD)number(L"nativePid",1,MAXDWORD);
  c.owner_exe=string(L"ownerExecutable");c.native_exe=string(L"nativeExecutable");
  c.owner_ticks=parse_number(string(L"ownerStartTimeTicks").c_str());c.native_ticks=parse_number(string(L"nativeStartTimeTicks").c_str());c.hwnd=parse_number(string(L"windowHandle").c_str());
  c.title=string(L"windowTitle");c.window_class=string(L"windowClass");
  c.adapter=(unsigned)number(L"adapterIndex",0,15);c.bitrate=(unsigned)number(L"bitrateMbps",50,600);c.port=(unsigned)number(L"rtmpPort",1,65535);
  c.media=to_string(object.GetNamedString(L"mediaPath"));c.user=to_string(object.GetNamedString(L"user"));c.password=to_string(object.GetNamedString(L"password"));
  if(!c.owner_ticks||!c.native_ticks||!c.hwnd||!owned_title(c.title.c_str())||c.window_class.empty()||c.window_class.size()>127||!hex_token(c.media)||!hex_token(c.user)||!hex_token(c.password))throw hresult_error(E_INVALIDARG);
  for(const auto ch:c.window_class)if(ch<32||ch==127)throw hresult_error(E_INVALIDARG);
  bool product_matches=false;
  for(const auto product:{L"WhiteCap",L"Aeon",L"G-Force"})for(const auto suffix:{L" Standalone.x64.exe",L" Standalone.exe"}) {
    const auto exe=std::wstring(L"C:\\Program Files (x86)\\SoundSpectrum\\")+product+L"\\"+product+suffix;
    const auto prefix=std::wstring(L"Rabbit Hole ")+product+L" RH-";
    if(_wcsicmp(exe.c_str(),c.native_exe.c_str())==0&&c.title.compare(0,prefix.size(),prefix)==0)product_matches=true;
  }
  const auto owner_base=wcsrchr(c.owner_exe.c_str(),L'\\');
  if(!product_matches||!owner_base||_wcsicmp(owner_base+1,L"node.exe"))throw hresult_error(E_INVALIDARG);
  return c;
}
static void verify_process(HANDLE process,const std::wstring& expected,unsigned long long expected_ticks) {
  WCHAR executable[32768];DWORD size=32768;FILETIME created,exit,kernel,user;
  check_bool(QueryFullProcessImageNameW(process,0,executable,&size));check_bool(GetProcessTimes(process,&created,&exit,&kernel,&user));
  const auto actual=((uint64_t)created.dwHighDateTime<<32|created.dwLowDateTime)+504911232000000000ULL;
  if(_wcsicmp(executable,expected.c_str())||actual!=expected_ticks)throw hresult_error(E_ACCESSDENIED);
}
struct Counter {
  unsigned long long frames=0,bytes=0,repeated=0,backwards=0;
  GstClockTime first=GST_CLOCK_TIME_NONE,last=GST_CLOCK_TIME_NONE,max_gap=0;
  bool gpu=true,same_device=true;
  bool caps_gpu=false,alignment_au=false;
  gint width=0,height=0,fps_n=0,fps_d=0;
};
struct Bridge {
  std::mutex callback_mutex,metrics;
  std::atomic<bool> closing{false};
  GstElement *pipeline=nullptr,*appsrc=nullptr;
  GstD3D11Device *device=nullptr;
  GstBufferPool *buffers=nullptr;
  GstClock *clock=nullptr;
  Counter counters[5];
  LONGLONG stream_start=0,last_encoded=0,last_stamp=0,origin_stamp=0;
  GstClockTime origin_running=0;
  unsigned long long sequence=0,last_output_sequence=0,pushed=0,output=0;
  unsigned long long events=0,empty=0,stale=0,pool_full=0,appsrc_drops=0,errors=0,push_failures=0;
  unsigned long long maximum_appsrc_buffers=0;
};
static void count(Counter& c,GstClockTime pts,guint64 bytes) {
  c.frames++;c.bytes+=bytes;
  if(!GST_CLOCK_TIME_IS_VALID(pts)){c.backwards++;return;}
  if(GST_CLOCK_TIME_IS_VALID(c.last)) {
    if(pts==c.last)c.repeated++;
    else if(pts<c.last)c.backwards++;
    else c.max_gap=std::max(c.max_gap,pts-c.last);
  } else c.first=pts;
  c.last=pts;
}
struct PadCounter { Bridge* bridge;unsigned index; };
static GstPadProbeReturn on_buffer(GstPad* pad,GstPadProbeInfo* info,gpointer opaque) {
  auto p=static_cast<PadCounter*>(opaque);auto& b=*p->bridge;
  GstBuffer* buffer=GST_PAD_PROBE_INFO_BUFFER(info);if(!buffer)return GST_PAD_PROBE_OK;
  const auto now=ticks();std::lock_guard<std::mutex> lock(b.metrics);
  if(p->index==4)b.last_encoded=now;
  if(p->index==2) {
    const auto sequence=GST_BUFFER_OFFSET(buffer);b.output++;
    if(sequence<=b.last_output_sequence){b.errors++;}
    else {
      const auto skipped=sequence-b.last_output_sequence-1;b.appsrc_drops+=skipped;
      b.last_output_sequence=sequence;
    }
  }
  auto& c=b.counters[p->index];
  if(!c.frames) {
    auto caps=gst_pad_get_current_caps(pad);
    if(caps&&gst_caps_get_size(caps)) {
      const auto structure=gst_caps_get_structure(caps,0);
      c.caps_gpu=gst_caps_features_contains(gst_caps_get_features(caps,0),GST_CAPS_FEATURE_MEMORY_D3D11_MEMORY);
      gst_structure_get_int(structure,"width",&c.width);gst_structure_get_int(structure,"height",&c.height);
      gst_structure_get_fraction(structure,"framerate",&c.fps_n,&c.fps_d);
      const auto alignment=gst_structure_get_string(structure,"alignment");c.alignment_au=alignment&&strcmp(alignment,"au")==0;
    }
    if(caps)gst_caps_unref(caps);
  }
  count(c,GST_BUFFER_PTS(buffer),gst_buffer_get_size(buffer));
  if(p->index==2 || p->index==3) {
    if(gst_buffer_n_memory(buffer)!=1)c.gpu=false;
    for(guint i=0;i<gst_buffer_n_memory(buffer);i++) {
      auto memory=gst_buffer_peek_memory(buffer,i);
      if(!gst_is_d3d11_memory(memory)){c.gpu=false;continue;}
      auto native=GST_D3D11_MEMORY_CAST(memory);
      if(gst_d3d11_device_get_device_handle(native->device)!=gst_d3d11_device_get_device_handle(b.device))c.same_device=false;
    }
  }
  return GST_PAD_PROBE_OK;
}
static void frame_arrived(const std::shared_ptr<Bridge>& b,const Direct3D11CaptureFramePool& sender) noexcept {
  std::lock_guard<std::mutex> serial(b->callback_mutex);
  if(b->closing.load())return;
  Direct3D11CaptureFrame frame{nullptr};GstBuffer* buffer=nullptr;GstMapInfo map=GST_MAP_INFO_INIT;
  GstMemory* mapped_memory=nullptr;bool locked=false;
  try {
    frame=sender.TryGetNextFrame();
    {std::lock_guard<std::mutex> lock(b->metrics);b->events++;
      if(!frame){b->empty++;return;}}
    const auto stamp=frame.SystemRelativeTime().count();
    if(stamp<=b->last_stamp) {
      frame.Close();frame=nullptr;
      std::lock_guard<std::mutex> lock(b->metrics);b->stale++;return;
    }
    b->last_stamp=stamp;
    if(!b->origin_stamp) {
      b->origin_stamp=stamp;const auto clock_time=gst_clock_get_time(b->clock),base=gst_element_get_base_time(b->pipeline);
      if(clock_time<base)throw hresult_error(E_FAIL);b->origin_running=clock_time-base;
    }
    const auto pts=b->origin_running+(stamp-b->origin_stamp)*100ULL;
    {std::lock_guard<std::mutex> lock(b->metrics);count(b->counters[0],pts,0);}
    GstBufferPoolAcquireParams acquire{};acquire.flags=GST_BUFFER_POOL_ACQUIRE_FLAG_DONTWAIT;
    const auto acquired=gst_buffer_pool_acquire_buffer(b->buffers,&buffer,&acquire);
    if(acquired==GST_FLOW_EOS) {
      frame.Close();frame=nullptr;
      std::lock_guard<std::mutex> lock(b->metrics);b->pool_full++;return;
    }
    if(acquired!=GST_FLOW_OK || !buffer || gst_buffer_n_memory(buffer)!=1)throw hresult_error(E_FAIL);
    auto memory=gst_buffer_peek_memory(buffer,0);
    if(!gst_is_d3d11_memory(memory)||GST_D3D11_MEMORY_CAST(memory)->device!=b->device)throw hresult_error(E_FAIL);
    com_ptr<ID3D11Texture2D> texture;auto access=frame.Surface().as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
    check_hresult(access->GetInterface(__uuidof(ID3D11Texture2D),texture.put_void()));
    com_ptr<ID3D11Device> source_device;texture->GetDevice(source_device.put());
    D3D11_TEXTURE2D_DESC source_desc{},destination_desc{};texture->GetDesc(&source_desc);
    if(source_device.get()!=gst_d3d11_device_get_device_handle(b->device)||source_desc.Width!=3840||source_desc.Height!=2160||source_desc.Format!=DXGI_FORMAT_B8G8R8A8_UNORM||source_desc.SampleDesc.Count!=1)throw hresult_error(E_FAIL);
    if(!gst_d3d11_memory_get_texture_desc(GST_D3D11_MEMORY_CAST(memory),&destination_desc)||destination_desc.Width!=3840||destination_desc.Height!=2160||destination_desc.Format!=source_desc.Format)throw hresult_error(E_FAIL);
    // GST_MAP_D3D11 maps the native texture handle; it never downloads pixels.
    if(!gst_memory_map(memory,&map,(GstMapFlags)(GST_MAP_WRITE|GST_MAP_D3D11)))throw hresult_error(E_FAIL);
    mapped_memory=memory;auto destination=reinterpret_cast<ID3D11Texture2D*>(map.data);
    if(!destination)throw hresult_error(E_FAIL);
    gst_d3d11_device_lock(b->device);locked=true;
    gst_d3d11_device_get_device_context_handle(b->device)->CopySubresourceRegion(destination,gst_d3d11_memory_get_subresource_index(GST_D3D11_MEMORY_CAST(memory)),0,0,0,texture.get(),0,nullptr);
    gst_d3d11_device_unlock(b->device);locked=false;
    gst_memory_unmap(memory,&map);mapped_memory=nullptr;
    frame.Close();frame=nullptr;texture=nullptr; // Return WGC pool immediately after queued GPU copy.
    GST_BUFFER_PTS(buffer)=pts;GST_BUFFER_DTS(buffer)=GST_CLOCK_TIME_NONE;GST_BUFFER_DURATION(buffer)=GST_CLOCK_TIME_NONE;
    GST_BUFFER_OFFSET(buffer)=++b->sequence;
    {std::lock_guard<std::mutex> lock(b->metrics);count(b->counters[1],pts,0);}
    auto submitted=buffer;buffer=nullptr;const auto flow=gst_app_src_push_buffer(GST_APP_SRC(b->appsrc),submitted);
    const auto queued=gst_app_src_get_current_level_buffers(GST_APP_SRC(b->appsrc));
    {std::lock_guard<std::mutex> lock(b->metrics);if(flow==GST_FLOW_OK)b->pushed++;else b->push_failures++;
      b->maximum_appsrc_buffers=std::max(b->maximum_appsrc_buffers,(unsigned long long)queued);}
  }catch(...) {
    if(locked)gst_d3d11_device_unlock(b->device);
    if(mapped_memory)gst_memory_unmap(mapped_memory,&map);
    if(buffer)gst_buffer_unref(buffer);
    try{if(frame)frame.Close();}catch(...){}
    std::lock_guard<std::mutex> lock(b->metrics);b->errors++;
  }
}

static unsigned long long pts_errors(const Bridge& b) {
  unsigned long long result=0;for(const auto& counter:b.counters)result+=counter.repeated+counter.backwards;return result;
}
static void print_stats(Bridge& b,GstElement* rate) {
  guint64 dropped=0,duplicated=0;if(rate)g_object_get(rate,"drop",&dropped,"duplicate",&duplicated,nullptr);
  std::lock_guard<std::mutex> lock(b.metrics);
  std::printf("{\"event\":\"stats\",\"protocol\":1,\"frames\":%llu,\"bytes\":%llu,\"elapsedMs\":%.6f,\"captureFrames\":%llu,\"copiedFrames\":%llu,\"appsrcFrames\":%llu,\"encoderFrames\":%llu,\"poolDrops\":%llu,\"appsrcDrops\":%llu,\"videorateDrops\":%llu,\"videorateDuplicates\":%llu,\"ptsErrors\":%llu,\"maximumAppsrcBuffers\":%llu,\"emptyEvents\":%llu,\"staleCaptureDrops\":%llu}\n",
    b.counters[4].frames,b.counters[4].bytes,b.stream_start?elapsed_ms(b.stream_start,ticks()):0.0,b.counters[0].frames,b.counters[1].frames,b.counters[2].frames,b.counters[3].frames,b.pool_full,b.appsrc_drops,(unsigned long long)dropped,(unsigned long long)duplicated,pts_errors(b),b.maximum_appsrc_buffers,b.empty,b.stale);std::fflush(stdout);
}
static int run_owned(int argc,wchar_t** argv) {
  Target target;Direct3D11CaptureFramePool pool{nullptr};GraphicsCaptureSession session{nullptr};
  event_token token{};bool registered=false,capture_started=false,handler_removed=false,session_closed=false,pool_closed=false;
  auto b=std::make_shared<Bridge>();GstElement *encoder=nullptr,*parser=nullptr,*rate=nullptr,*publisher=nullptr;GstBus* bus=nullptr;
  GstPad *pads[3]={};gulong probe_ids[3]={};PadCounter probes[3]={{b.get(),2},{b.get(),3},{b.get(),4}};
  bool requested_stop=false,eos=false,pipeline_stopped=false,buffers_stopped=false;unsigned long error_number=0;
  const char* failure_code="invalid-config";int result=1;
  try {
    if(argc!=3||wcscmp(argv[1],L"--owned-hls"))throw hresult_error(E_INVALIDARG);
    const std::wstring marker=argv[2];const auto marker_prefix=std::wstring(L"HlsEncoder");
    if(marker.compare(0,marker_prefix.size(),marker_prefix)||!hex_token(to_string(marker.substr(marker_prefix.size()))))throw hresult_error(E_INVALIDARG);
    const auto config=parse_config(read_config_line());
    const auto adapter=config.adapter,bitrate=config.bitrate;
    failure_code="invalid-owner";target.owner=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,config.owner_pid);
    if(!target.owner||!owned_lineage(config.owner_pid,config.native_pid))throw hresult_error(E_ACCESSDENIED);
    verify_process(target.owner,config.owner_exe,config.owner_ticks);
    failure_code="invalid-window";target.process=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,config.native_pid);
    if(!target.process)throw_last_error();verify_process(target.process,config.native_exe,config.native_ticks);
    target.pid=config.native_pid;target.hwnd=(HWND)(uintptr_t)config.hwnd;target.expected_title=config.title;target.expected_class=config.window_class;
    if(!target.valid())throw hresult_error(E_ACCESSDENIED);
    failure_code="unsupported-runtime";gst_init(nullptr,nullptr);gst_debug_set_default_threshold(GST_LEVEL_NONE);gst_debug_set_active(FALSE);guint major,minor,micro,nano;gst_version(&major,&minor,&micro,&nano);if(major!=1||minor!=26||micro!=11)throw hresult_error(E_FAIL);
    failure_code="gpu-resource-error";b->device=gst_d3d11_device_new((guint)adapter,D3D11_CREATE_DEVICE_BGRA_SUPPORT);if(!b->device)throw hresult_error(E_FAIL);
    auto native_device=gst_d3d11_device_get_device_handle(b->device);com_ptr<IDXGIDevice> dxgi;check_hresult(native_device->QueryInterface(__uuidof(IDXGIDevice),dxgi.put_void()));com_ptr<IInspectable> inspectable;
    check_hresult(CreateDirect3D11DeviceFromDXGIDevice(dxgi.get(),inspectable.put()));auto winrt_device=inspectable.as<IDirect3DDevice>();
    failure_code="gpu-resource-error";GstVideoInfo video{};gst_video_info_set_format(&video,GST_VIDEO_FORMAT_BGRA,3840,2160);video.fps_n=0;video.fps_d=1;video.par_n=1;video.par_d=1;if(!gst_video_colorimetry_from_string(&video.colorimetry,"sRGB"))throw hresult_error(E_FAIL);
    GstCaps* caps=gst_video_info_to_caps(&video);gst_caps_set_features(caps,0,gst_caps_features_new(GST_CAPS_FEATURE_MEMORY_D3D11_MEMORY,nullptr));
    b->buffers=gst_d3d11_buffer_pool_new(b->device);auto buffer_config=gst_buffer_pool_get_config(b->buffers);gst_buffer_pool_config_set_params(buffer_config,caps,(guint)video.size,8,8);
    gst_buffer_pool_config_add_option(buffer_config,GST_BUFFER_POOL_OPTION_VIDEO_META);auto allocation=gst_d3d11_allocation_params_new(b->device,&video,GST_D3D11_ALLOCATION_FLAG_DEFAULT,D3D11_BIND_SHADER_RESOURCE|D3D11_BIND_RENDER_TARGET,0);
    if(!allocation){gst_caps_unref(caps);gst_structure_free(buffer_config);throw hresult_error(E_FAIL);}gst_buffer_pool_config_set_d3d11_allocation_params(buffer_config,allocation);gst_d3d11_allocation_params_free(allocation);
    const bool configured=gst_buffer_pool_set_config(b->buffers,buffer_config)&&gst_buffer_pool_set_active(b->buffers,TRUE);if(!configured){gst_caps_unref(caps);throw hresult_error(E_FAIL);}
    // Same 4K/bitrate: p5 capped measured 120-fps sessions near 83; p4 sustained
    // genuine 120 with no duplicate frames. Preserve the existing 60-fps preset.
    const char* encoder_preset=config.fps==120?"p4":"p5";
    failure_code="pipeline-error";char description[1400];std::snprintf(description,sizeof(description),"appsrc name=Input is-live=true format=time do-timestamp=false block=false max-buffers=2 max-bytes=0 max-time=0 leaky-type=downstream ! d3d11convert ! video/x-raw(memory:D3D11Memory),format=NV12,width=3840,height=2160,pixel-aspect-ratio=1/1,colorimetry=bt709 ! videorate name=Rate drop-only=%s skip-to-first=true max-rate=%u max-duplication-time=50000000 max-closing-segment-duplication-duration=0 ! video/x-raw(memory:D3D11Memory),framerate=%u/1 ! nvd3d11h264enc name=Encode preset=%s tune=low-latency rc-mode=cbr bitrate=%u max-bitrate=%u gop-size=%u bframes=0 rc-lookahead=0 multi-pass=disabled zerolatency=true repeat-sequence-header=true aud=true ! video/x-h264,profile=high,stream-format=byte-stream,alignment=au ! h264parse name=Parse config-interval=-1 ! flvmux streamable=true ! rtmp2sink name=Publisher sync=false chunk-size=65536",config.fps==120?"true":"false",config.fps,config.fps,encoder_preset,(unsigned)((bitrate*1000000ULL+512)/1024),(unsigned)((bitrate*1000000ULL+512)/1024),config.fps/5);
    GError* parse_error=nullptr;b->pipeline=gst_parse_launch(description,&parse_error);if(parse_error){g_error_free(parse_error);gst_caps_unref(caps);throw hresult_error(E_FAIL);}if(!b->pipeline){gst_caps_unref(caps);throw hresult_error(E_FAIL);}
    publisher=gst_bin_get_by_name(GST_BIN(b->pipeline),"Publisher");if(!publisher)throw hresult_error(E_FAIL);
    const auto publish_url=std::string("rtmp://127.0.0.1:")+std::to_string(config.port)+"/"+config.media+"?user="+config.user+"&pass="+config.password;
    g_object_set(publisher,"location",publish_url.c_str(),nullptr);
    auto gst_context=gst_d3d11_context_new(b->device);gst_element_set_context(b->pipeline,gst_context);gst_context_unref(gst_context);
    b->appsrc=gst_bin_get_by_name(GST_BIN(b->pipeline),"Input");encoder=gst_bin_get_by_name(GST_BIN(b->pipeline),"Encode");parser=gst_bin_get_by_name(GST_BIN(b->pipeline),"Parse");rate=gst_bin_get_by_name(GST_BIN(b->pipeline),"Rate");
    if(!b->appsrc||!encoder||!parser||!rate){gst_caps_unref(caps);throw hresult_error(E_FAIL);}gst_app_src_set_caps(GST_APP_SRC(b->appsrc),caps);gst_caps_unref(caps);
    pads[0]=gst_element_get_static_pad(b->appsrc,"src");pads[1]=gst_element_get_static_pad(encoder,"sink");pads[2]=gst_element_get_static_pad(parser,"src");
    for(unsigned i=0;i<3;i++){if(!pads[i])throw hresult_error(E_FAIL);probe_ids[i]=gst_pad_add_probe(pads[i],GST_PAD_PROBE_TYPE_BUFFER,on_buffer,&probes[i],nullptr);}
    bus=gst_element_get_bus(b->pipeline);b->clock=gst_system_clock_obtain();gst_pipeline_use_clock(GST_PIPELINE(b->pipeline),b->clock);
    failure_code="pipeline-error";if(gst_element_set_state(b->pipeline,GST_STATE_PLAYING)==GST_STATE_CHANGE_FAILURE)throw hresult_error(E_FAIL);
    failure_code="capture-unavailable";auto interop=get_activation_factory<GraphicsCaptureItem,IGraphicsCaptureItemInterop>();GraphicsCaptureItem item{nullptr};check_hresult(interop->CreateForWindow(target.hwnd,guid_of<GraphicsCaptureItem>(),put_abi(item)));
    if(item.Size().Width!=3840||item.Size().Height!=2160)throw hresult_error(E_INVALIDARG);
    pool=Direct3D11CaptureFramePool::CreateFreeThreaded(winrt_device,DirectXPixelFormat::B8G8R8A8UIntNormalized,2,item.Size());token=pool.FrameArrived([b](const Direct3D11CaptureFramePool& sender,const winrt::Windows::Foundation::IInspectable&){frame_arrived(b,sender);});registered=true;
    session=pool.CreateCaptureSession(item);session.IsCursorCaptureEnabled(false);auto session5=session.as<RHGraphicsCaptureSession5>();RHTimeSpan interval{};check_hresult(session5->get_MinUpdateInterval(&interval));const auto before=interval.Duration;(void)before;
    check_hresult(session5->put_MinUpdateInterval(RHTimeSpan{10000}));check_hresult(session5->get_MinUpdateInterval(&interval));const auto after=interval.Duration;if(after!=10000)throw hresult_error(E_FAIL);
    std::printf("{\"event\":\"ready\",\"protocol\":1,\"version\":\"%s\",\"interval100ns\":10000,\"width\":3840,\"height\":2160,\"targetFps\":%u,\"encoderPreset\":\"%s\",\"gpuPoolMaximum\":8,\"appsrcMaximum\":2}\n",VERSION,config.fps,encoder_preset);std::fflush(stdout);
    failure_code="capture-unavailable";b->stream_start=ticks();session.StartCapture();capture_started=true;auto last_stats=ticks();
    for(;;) {
      if(stop_requested()){requested_stop=true;result=0;break;}
      failure_code="owner-lost";if(WaitForSingleObject(target.owner,0)!=WAIT_TIMEOUT)throw hresult_error(E_ACCESSDENIED);
      failure_code="window-lost";if(!target.valid())throw hresult_error(E_ACCESSDENIED);
      failure_code="pipeline-error";
      if(auto message=gst_bus_pop_filtered(bus,(GstMessageType)(GST_MESSAGE_ERROR|GST_MESSAGE_EOS))) {gst_message_unref(message);throw hresult_error(E_FAIL);}
      {
        std::lock_guard<std::mutex> lock(b->metrics);
        failure_code="gpu-resource-error";if(b->errors||b->push_failures||b->maximum_appsrc_buffers>2)throw hresult_error(E_FAIL);
        for(unsigned i=2;i<4;i++) {const auto& c=b->counters[i];if(c.frames&&(!c.gpu||!c.same_device||!c.caps_gpu||c.width!=3840||c.height!=2160))throw hresult_error(E_FAIL);}
        if(b->counters[3].frames&&(b->counters[3].fps_n!=(gint)config.fps||b->counters[3].fps_d!=1))throw hresult_error(E_FAIL);
        if(b->counters[4].frames&&!b->counters[4].alignment_au)throw hresult_error(E_FAIL);
        failure_code="timestamp-error";if(pts_errors(*b))throw hresult_error(E_FAIL);
        failure_code="counter-limit";for(const auto& c:b->counters)if(c.frames>9007199254740991ULL||c.bytes>9007199254740991ULL)throw hresult_error(E_FAIL);
        failure_code="encoded-output-stale";
        if((b->last_encoded&&elapsed_ms(b->last_encoded,ticks())>6000)||(!b->last_encoded&&elapsed_ms(b->stream_start,ticks())>10000))throw hresult_error(HRESULT_FROM_WIN32(ERROR_TIMEOUT));
      }
      if(elapsed_ms(last_stats,ticks())>=1000){print_stats(*b,rate);last_stats=ticks();}
      Sleep(20);
    }
  }catch(const hresult_error& error){error_number=(unsigned long)error.code().value;}catch(...){error_number=(unsigned long)E_FAIL;}
  if(result!=0){std::printf("{\"event\":\"error\",\"protocol\":1,\"code\":\"%s\",\"detailCode\":%lu}\n",failure_code,error_number);std::fflush(stdout);}
  // This process-only last resort bounds teardown even when the former parent has exited.
  // A live parent still performs its independently verified exact-process kill fallback.
  HANDLE cleanup_done=CreateEventW(nullptr,TRUE,FALSE,nullptr);std::thread cleanup_limit;
  if(cleanup_done)cleanup_limit=std::thread([cleanup_done]{if(WaitForSingleObject(cleanup_done,8000)==WAIT_TIMEOUT)TerminateProcess(GetCurrentProcess(),79);});
  b->closing.store(true);
  try{if(registered)pool.FrameArrived(token);handler_removed=true;}catch(...){result=1;}
  try{if(session)session.Close();session_closed=true;}catch(...){result=1;}
  try{if(pool)pool.Close();pool_closed=true;}catch(...){result=1;}
  {std::lock_guard<std::mutex> finish_callback(b->callback_mutex);}
  if(b->appsrc&&b->pipeline&&bus&&capture_started) {
    gst_app_src_end_of_stream(GST_APP_SRC(b->appsrc));auto message=gst_bus_timed_pop_filtered(bus,3*GST_SECOND,(GstMessageType)(GST_MESSAGE_EOS|GST_MESSAGE_ERROR));
    if(message){eos=GST_MESSAGE_TYPE(message)==GST_MESSAGE_EOS;gst_message_unref(message);}if(requested_stop&&!eos)result=1;
  }else eos=true;
  if(capture_started)print_stats(*b,rate);
  if(b->pipeline) {
    gst_element_set_state(b->pipeline,GST_STATE_NULL);GstState current=GST_STATE_VOID_PENDING,pending=GST_STATE_VOID_PENDING;
    const auto state=gst_element_get_state(b->pipeline,&current,&pending,3*GST_SECOND);pipeline_stopped=state!=GST_STATE_CHANGE_FAILURE&&current==GST_STATE_NULL;
  }else pipeline_stopped=true;
  for(unsigned i=0;i<3;i++)if(pads[i]){if(probe_ids[i])gst_pad_remove_probe(pads[i],probe_ids[i]);gst_object_unref(pads[i]);}
  if(bus)gst_object_unref(bus);if(publisher)gst_object_unref(publisher);if(rate)gst_object_unref(rate);if(parser)gst_object_unref(parser);if(encoder)gst_object_unref(encoder);
  if(b->appsrc){gst_object_unref(b->appsrc);b->appsrc=nullptr;}if(b->pipeline){gst_object_unref(b->pipeline);b->pipeline=nullptr;}
  if(b->buffers){buffers_stopped=gst_buffer_pool_set_active(b->buffers,FALSE);gst_object_unref(b->buffers);b->buffers=nullptr;}else buffers_stopped=true;
  if(b->clock)gst_object_unref(b->clock);if(b->device)gst_object_unref(b->device);
  if(!handler_removed||!session_closed||!pool_closed||!pipeline_stopped||!buffers_stopped)result=1;
  if(requested_stop&&result!=0){std::puts("{\"event\":\"error\",\"protocol\":1,\"code\":\"stop-failed\"}");}
  std::printf("{\"event\":\"stopped\",\"protocol\":1,\"graceful\":%s,\"handlerRemoved\":%s,\"sessionClosed\":%s,\"poolClosed\":%s,\"eosDrained\":%s,\"pipelineStopped\":%s,\"buffersStopped\":%s}\n",result==0?"true":"false",handler_removed?"true":"false",session_closed?"true":"false",pool_closed?"true":"false",eos?"true":"false",pipeline_stopped?"true":"false",buffers_stopped?"true":"false");std::fflush(stdout);
  if(cleanup_done){SetEvent(cleanup_done);cleanup_limit.join();CloseHandle(cleanup_done);}
  return result;
}
int wmain(int argc,wchar_t** argv) {
  LARGE_INTEGER value;if(!QueryPerformanceFrequency(&value)||value.QuadPart<=0)return 2;frequency=value.QuadPart;
  if(argc==2&&wcscmp(argv[1],L"--version")==0) {
    guint major,minor,micro,nano;gst_version(&major,&minor,&micro,&nano);
    std::printf("{\"protocol\":1,\"version\":\"%s\",\"gstreamerVersion\":\"%u.%u.%u\"}\n",VERSION,major,minor,micro);return 0;
  }
  try{init_apartment(apartment_type::multi_threaded);const auto result=run_owned(argc,argv);uninit_apartment();return result;}
  catch(...){std::puts("{\"event\":\"error\",\"protocol\":1,\"code\":\"native-initialization-failed\"}");return 2;}
}
