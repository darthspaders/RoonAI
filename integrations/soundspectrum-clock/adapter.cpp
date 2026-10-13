#include "common.hpp"
#include <commctrl.h>
#include <atomic>
#include <mutex>
// All render entry, timer changes and subclass changes run on the host UI thread.
// No code bytes/import tables in the vendor executable are patched.
static HMODULE selfModule=nullptr;
static HANDLE ownerMutex=nullptr;
static std::atomic<int> state{0}; // 0=new,1=waiting,2=active,3=restoring,4=fallback,5=closing,6=claiming
static std::atomic<HHOOK> messageHook{nullptr};static HWND target=nullptr;static DWORD uiThread=0;
static HANDLE stopEvent=nullptr,wakeEvent=nullptr,clockTimer=nullptr;
static UINT_PTR timerId=0;static TIMERPROC timerProc=nullptr;static UINT controlMessage=0,tickMessage=0;
static std::atomic<bool> recoveryPending{false};
static BYTE* host=nullptr;static unsigned fps=0;static const Product* product=nullptr;
static std::atomic<unsigned long long> rendered{0},suppressed{0},missed{0};
static std::atomic<unsigned long long> dispatchUs{0},maxDispatchUs{0};
static std::mutex logMutex;
static void logEvent(const char* event,DWORD error=0){
 std::lock_guard<std::mutex> lock(logMutex);const auto dir=folder(modulePath(selfModule))+L"\\logs";CreateDirectoryW(dir.c_str(),nullptr);
 auto file=dir+L"\\"+(product?product->name:L"unknown")+L"-"+std::to_wstring(GetCurrentProcessId())+L".jsonl";
 HANDLE f=CreateFileW(file.c_str(),FILE_APPEND_DATA,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_ALWAYS,0,nullptr);if(f==INVALID_HANDLE_VALUE)return;
 LARGE_INTEGER size{};GetFileSizeEx(f,&size);
 if(size.QuadPart>=4*1024*1024){CloseHandle(f);if(!MoveFileExW(file.c_str(),(file+L".previous").c_str(),MOVEFILE_REPLACE_EXISTING)&&strcmp(event,"cadence")==0)return;f=CreateFileW(file.c_str(),FILE_APPEND_DATA,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_ALWAYS,0,nullptr);if(f==INVALID_HANDLE_VALUE)return;}
 char line[640];const auto n=snprintf(line,sizeof(line),"{\"event\":\"%s\",\"pid\":%lu,\"ticksMs\":%llu,\"state\":%d,\"targetFps\":%u,\"renders\":%llu,\"suppressedTimers\":%llu,\"missedDeadlines\":%llu,\"dispatchUs\":%llu,\"maxDispatchUs\":%llu,\"error\":%lu}\n",event,GetCurrentProcessId(),GetTickCount64(),state.load(),fps,rendered.load(),suppressed.load(),missed.load(),dispatchUs.load(),maxDispatchUs.load(),error);DWORD written;WriteFile(f,line,(DWORD)n,&written,nullptr);CloseHandle(f);
}
static bool validObject(UINT_PTR id){
 __try {auto p=(BYTE*)id;auto vt=*(BYTE***)p;return p&&vt&&vt[0x80/8]==host+0x9f70&&vt[0xc0/8]==host+0x9940&&*(HWND*)(p+0x80)==target&&p[0x6a]==0;}__except(EXCEPTION_EXECUTE_HANDLER){return false;}
}
static UINT originalInterval(){__try {const auto v=*(int*)((BYTE*)timerId+0x50);return (UINT)std::max(0,std::min(v,10000))+2;}__except(EXCEPTION_EXECUTE_HANDLER){return 2;}}
static void removeHook(){if(auto hook=messageHook.exchange(nullptr))UnhookWindowsHookEx(hook);}
static void restore(const char* reason){
 if(GetCurrentThreadId()!=uiThread)return;
 if(state.load()==4||state.load()==5)return;
 state=3;SetEvent(stopEvent);removeHook();
 // Never resurrect a timer on a destroyed/replaced object.
 if(IsWindow(target)&&validObject(timerId)){
   const auto result=SetTimer(target,timerId,originalInterval(),timerProc);
   if(!result){logEvent("restore-failed",GetLastError());recoveryPending=false;return;}
 }
 state=4;logEvent(reason);
}
static LRESULT CALLBACK subclass(HWND h,UINT m,WPARAM w,LPARAM l,UINT_PTR id,DWORD_PTR){
 if(m==controlMessage){restore("fallback-restored");return 0;}
 if(m==tickMessage){if(state.load()!=2)return 0;if(!validObject(timerId)){restore("object-lost-fallback");return 0;}return DefSubclassProc(h,0x209,0,0xdeadbeef);}
 if(m==WM_CLOSE)restore("shutdown-restored");
 if(m==WM_NCDESTROY){state=5;SetEvent(stopEvent);removeHook();RemoveWindowSubclass(h,subclass,id);logEvent("window-destroyed");}
 return DefSubclassProc(h,m,w,l);
}
static LRESULT CALLBACK getMessage(int code,WPARAM mode,LPARAM value){
 if(code>=0&&mode==PM_REMOVE){auto msg=(MSG*)value;
   if(msg->hwnd==target&&msg->message==WM_TIMER&&(TIMERPROC)msg->lParam==timerProc){
     int waiting=1;
     if(validObject(msg->wParam)&&state.compare_exchange_strong(waiting,6)){
       timerId=msg->wParam;
       if(SetWindowSubclass(target,subclass,(UINT_PTR)selfModule,0)&&KillTimer(target,timerId)){
         state=2;SetEvent(wakeEvent);logEvent("clock-active");
       }else {state=4;SetEvent(stopEvent);logEvent("initialization-fallback",GetLastError());removeHook();}
     }
     if(state.load()==2&&msg->wParam!=timerId){state=4;SetEvent(stopEvent);removeHook();logEvent("new-host-timer-fallback");}
     if(state.load()==2&&msg->wParam==timerId){KillTimer(target,timerId);msg->message=WM_NULL;msg->lParam=0;suppressed++;}
   }
 }
 return CallNextHookEx(nullptr,code,mode,value);
}
static BOOL CALLBACK findWindow(HWND h,LPARAM){DWORD pid=0;const DWORD tid=GetWindowThreadProcessId(h,&pid);wchar_t cls[128]{};GetClassNameW(h,cls,128);const auto expected=std::wstring(L"SoundSpectrum ")+product->name+L" Standalone";if(pid==GetCurrentProcessId()&&expected==cls){target=h;uiThread=tid;return FALSE;}return TRUE;}
static DWORD WINAPI run(void*){
 for(unsigned i=0;i<300&&!target;i++){EnumWindows(findWindow,0);if(!target)Sleep(100);}
 if(!target){state=4;logEvent("no-window-fallback");return 0;}
 clockTimer=CreateWaitableTimerExW(nullptr,nullptr,2,TIMER_ALL_ACCESS);
 stopEvent=CreateEventW(nullptr,TRUE,FALSE,nullptr);wakeEvent=CreateEventW(nullptr,TRUE,FALSE,nullptr);
 if(!clockTimer||!stopEvent||!wakeEvent){state=4;logEvent("timer-init-fallback",GetLastError());goto cleanup;}
 controlMessage=RegisterWindowMessageW(L"RabbitHole.SoundSpectrum.NativeClock.Restore.v1");
 tickMessage=RegisterWindowMessageW(L"RabbitHole.SoundSpectrum.NativeClock.Tick.v1");
 if(!controlMessage||!tickMessage){state=4;logEvent("message-init-fallback",GetLastError());goto cleanup;}
 messageHook=SetWindowsHookExW(WH_GETMESSAGE,getMessage,selfModule,uiThread);
 if(!messageHook){state=4;logEvent("hook-init-fallback",GetLastError());goto cleanup;}
 if(state.load()==3||state.load()==4||state.load()==5){removeHook();goto cleanup;}
 {
   HANDLE waiters[2]={stopEvent,wakeEvent};
   if(WaitForMultipleObjects(2,waiters,FALSE,15000)!=WAIT_OBJECT_0+1){
     int waiting=1;
     if(state.compare_exchange_strong(waiting,4)){removeHook();logEvent("host-timer-not-recognized");goto cleanup;}
     // The UI thread won ownership; it alone must finish claim or restore it.
     while(state.load()==6)WaitForSingleObject(wakeEvent,100);
     if(state.load()!=2)goto cleanup;
   }
   LARGE_INTEGER frequency,start,now;QueryPerformanceFrequency(&frequency);QueryPerformanceCounter(&start);long long tick=1;auto lastLog=GetTickCount64();
   while(state.load()==2&&WaitForSingleObject(stopEvent,0)==WAIT_TIMEOUT){
     DWORD pid=0;GetWindowThreadProcessId(target,&pid);if(!IsWindow(target)||pid!=GetCurrentProcessId()){state=5;logEvent("window-lost");break;}
     QueryPerformanceCounter(&now);const auto deadline=start.QuadPart+frequency.QuadPart*tick/fps;
     LARGE_INTEGER due;due.QuadPart=-std::max(1LL,(deadline-now.QuadPart)*10000000LL/frequency.QuadPart);
     if(!SetWaitableTimer(clockTimer,&due,0,nullptr,nullptr,FALSE)){logEvent("clock-error",GetLastError());break;}
     HANDLE waits[2]={stopEvent,clockTimer};if(WaitForMultipleObjects(2,waits,FALSE,2000)!=WAIT_OBJECT_0+1)break;
     if(state.load()!=2)break;DWORD_PTR hint=0;
     LARGE_INTEGER beginDispatch;QueryPerformanceCounter(&beginDispatch);
     SetLastError(ERROR_SUCCESS);
     if(!SendMessageTimeoutW(target,tickMessage,0,0,SMTO_BLOCK|SMTO_ABORTIFHUNG|SMTO_ERRORONEXIT,500,&hint)){logEvent("ui-dispatch-timeout",GetLastError());break;}
     if(state.load()!=2)break;
     rendered++;QueryPerformanceCounter(&now);const auto work=(unsigned long long)((now.QuadPart-beginDispatch.QuadPart)*1000000LL/frequency.QuadPart);dispatchUs+=work;maxDispatchUs=std::max(maxDispatchUs.load(),work);
     // Start-to-start deadlines: retain the immediately due frame after a slight overrun.
     // Drop whole older deadlines; never enqueue multiple renders or duplicate frames.
     const auto next=std::max(tick+1,(now.QuadPart-start.QuadPart)*fps/frequency.QuadPart);missed+=next-tick-1;tick=next;
     if(GetTickCount64()-lastLog>=2000){logEvent("cadence");lastLog=GetTickCount64();}
   }
   // Recovery is queued to the UI thread; a hung UI must resume before either clock can render.
   while(state.load()!=4&&state.load()!=5&&IsWindow(target)){
     int active=2;state.compare_exchange_strong(active,3);
     if(state.load()==3&&!recoveryPending.exchange(true)&&!PostMessageW(target,controlMessage,0,0))recoveryPending=false;Sleep(100);
   }
 }
cleanup:
 // Handles remain valid while the UI subclass exists, including later WM_CLOSE/NCDESTROY.
 if(clockTimer){CancelWaitableTimer(clockTimer);CloseHandle(clockTimer);clockTimer=nullptr;}
 logEvent("clock-worker-ended");return 0;
}
extern "C" __declspec(dllexport) DWORD WINAPI RhClockBootstrap(void*){
 int expected=0;if(!state.compare_exchange_strong(expected,1))return 0;
 const auto ownerName=std::wstring(L"Local\\RabbitHole.NativeClock.Process.")+std::to_wstring(GetCurrentProcessId());
 ownerMutex=CreateMutexW(nullptr,FALSE,ownerName.c_str());if(!ownerMutex||GetLastError()==ERROR_ALREADY_EXISTS){if(ownerMutex)CloseHandle(ownerMutex);ownerMutex=nullptr;state=4;logEvent("another-clock-owner");return 6;}
 const auto file=modulePath();product=recognize(file);if(!product){state=4;logEvent("unsupported-build-fallback");return 1;}
 const auto engine=GetModuleHandleW(product->engine);const auto expectedEngine=folder(file)+L"\\"+product->engine;
 if(!engine||!sameFile(modulePath(engine),expectedEngine)||sha256(modulePath(engine))!=product->engineHash){state=4;logEvent("engine-identity-fallback",!engine?1:!sameFile(modulePath(engine),expectedEngine)?2:3);return 2;}
 fps=configuredFps(*product);if(!fps){state=4;logEvent("invalid-target-fallback");return 3;}
 host=(BYTE*)GetModuleHandleW(nullptr);timerProc=(TIMERPROC)(host+0x9860);
 HMODULE pinned=nullptr;if(!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS|GET_MODULE_HANDLE_EX_FLAG_PIN,(LPCWSTR)&RhClockBootstrap,&pinned)){state=4;return 4;}
 const auto thread=CreateThread(nullptr,0,run,nullptr,0,nullptr);if(!thread){state=4;logEvent("worker-init-fallback",GetLastError());return 5;}CloseHandle(thread);logEvent("bootstrap");return 0;
}
BOOL WINAPI DllMain(HINSTANCE h,DWORD reason,LPVOID){if(reason==DLL_PROCESS_ATTACH){selfModule=h;DisableThreadLibraryCalls(h);}return TRUE;}
