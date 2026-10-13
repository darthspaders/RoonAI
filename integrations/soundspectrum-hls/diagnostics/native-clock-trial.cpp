// Bounded diagnostic clock. Render via the host's existing synchronous UI dispatch.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <atomic>
static HANDLE worker=nullptr, stopped=nullptr;
static HWND target=nullptr;
static UINT_PTR identifier=0;
static TIMERPROC callback=nullptr;
static std::atomic<long> pending{0},posted{0},skipped{0},failure{0};
static DWORD WINAPI run(void*) {
  HANDLE timer=CreateWaitableTimerExW(nullptr,nullptr,2,TIMER_ALL_ACCESS);
  if(!timer){failure=GetLastError();return 1;}
  LARGE_INTEGER frequency,start,now;QueryPerformanceFrequency(&frequency);QueryPerformanceCounter(&start);
  long long tick=1;
  while(WaitForSingleObject(stopped,0)==WAIT_TIMEOUT) {
    QueryPerformanceCounter(&now);
    if(now.QuadPart-start.QuadPart>frequency.QuadPart*25)break;
    const auto deadline=start.QuadPart+(frequency.QuadPart*tick)/120;
    LARGE_INTEGER due;due.QuadPart=-max(1LL,(deadline-now.QuadPart)*10000000LL/frequency.QuadPart);
    if(!SetWaitableTimer(timer,&due,0,nullptr,nullptr,FALSE)){failure=GetLastError();break;}
    HANDLE handles[2]={stopped,timer};
    if(WaitForMultipleObjects(2,handles,FALSE,1000)!=WAIT_OBJECT_0+1)break;
    if(!IsWindow(target))break;
    DWORD_PTR hint=0;
    if(SendMessageTimeoutW(target,0x209,0,0xdeadbeef,SMTO_ABORTIFHUNG|SMTO_BLOCK,500,&hint))posted++;
    else {failure=GetLastError();break;}
    QueryPerformanceCounter(&now);
    tick=max(tick+1,((now.QuadPart-start.QuadPart)*120)/frequency.QuadPart+1);
  }
  CancelWaitableTimer(timer);CloseHandle(timer);return 0;
}
extern "C" __declspec(dllexport) int RhClockStart(HWND hwnd,UINT_PTR id,TIMERPROC proc){
  DWORD pid=0;const DWORD tid=GetWindowThreadProcessId(hwnd,&pid);RECT rc{};
  if(worker||pid!=GetCurrentProcessId()||tid!=GetCurrentThreadId()||!proc||!id||
    !GetClientRect(hwnd,&rc)||rc.right!=3840||rc.bottom!=2160)return 0;
  stopped=CreateEventW(nullptr,TRUE,FALSE,nullptr);if(!stopped)return 0;
  target=hwnd;identifier=id;callback=proc;pending=0;posted=0;skipped=0;failure=0;
  worker=CreateThread(nullptr,0,run,nullptr,0,nullptr);
  if(!worker){CloseHandle(stopped);stopped=nullptr;return 0;}return 1;
}
extern "C" __declspec(dllexport) void RhClockAcknowledge(){pending=0;}
extern "C" __declspec(dllexport) void RhClockRequestStop(){if(stopped)SetEvent(stopped);}
extern "C" __declspec(dllexport) int RhClockStop(){
  if(!worker)return 1;SetEvent(stopped);
  if(WaitForSingleObject(worker,2000)!=WAIT_OBJECT_0)return 0;
  CloseHandle(worker);CloseHandle(stopped);worker=nullptr;stopped=nullptr;return 1;
}
extern "C" __declspec(dllexport) long RhClockPosted(){return posted;}
extern "C" __declspec(dllexport) long RhClockSkipped(){return skipped;}
extern "C" __declspec(dllexport) long RhClockError(){return failure;}
BOOL WINAPI DllMain(HINSTANCE,DWORD,LPVOID){return TRUE;}
