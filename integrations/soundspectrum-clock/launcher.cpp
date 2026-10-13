#include "common.hpp"
#include <tlhelp32.h>
#include <shellapi.h>
#include <map>
static std::wstring ownDir;
static void logEvent(const char* event,DWORD pid,DWORD error=0){
 const auto dir=ownDir+L"\\logs";CreateDirectoryW(dir.c_str(),nullptr);HANDLE f=CreateFileW((dir+L"\\launcher.jsonl").c_str(),FILE_APPEND_DATA,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_ALWAYS,0,nullptr);if(f==INVALID_HANDLE_VALUE)return;
 LARGE_INTEGER size{};GetFileSizeEx(f,&size);if(size.QuadPart<4*1024*1024){char line[256];auto n=snprintf(line,sizeof(line),"{\"event\":\"%s\",\"pid\":%lu,\"ticksMs\":%llu,\"error\":%lu}\n",event,pid,GetTickCount64(),error);DWORD out;WriteFile(f,line,(DWORD)n,&out,nullptr);}CloseHandle(f);
}
static bool sameUser(HANDLE process){
 HANDLE a=nullptr,b=nullptr;bool same=false;
 if(OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&a)&&OpenProcessToken(process,TOKEN_QUERY,&b)){
   DWORD na=0,nb=0;GetTokenInformation(a,TokenUser,nullptr,0,&na);GetTokenInformation(b,TokenUser,nullptr,0,&nb);
   std::vector<BYTE> ba(na),bb(nb);if(na&&nb&&GetTokenInformation(a,TokenUser,ba.data(),na,&na)&&GetTokenInformation(b,TokenUser,bb.data(),nb,&nb))same=EqualSid(((TOKEN_USER*)ba.data())->User.Sid,((TOKEN_USER*)bb.data())->User.Sid)!=0;
 }if(a)CloseHandle(a);if(b)CloseHandle(b);return same;
}
static uintptr_t remoteModule(DWORD pid,const std::wstring& name,bool fullPath=false){
 HANDLE snap=CreateToolhelp32Snapshot(TH32CS_SNAPMODULE|TH32CS_SNAPMODULE32,pid);if(snap==INVALID_HANDLE_VALUE)return 0;
 MODULEENTRY32W e{};e.dwSize=sizeof(e);uintptr_t result=0;if(Module32FirstW(snap,&e))do{if(!_wcsicmp(fullPath?e.szExePath:e.szModule,name.c_str())){result=(uintptr_t)e.modBaseAddr;break;}}while(Module32NextW(snap,&e));CloseHandle(snap);return result;
}
static bool remoteCall(HANDLE process,uintptr_t function,void* arg,bool bootstrap=false){
 HANDLE thread=CreateRemoteThread(process,nullptr,0,(LPTHREAD_START_ROUTINE)function,arg,0,nullptr);if(!thread)return false;
 const auto wait=WaitForSingleObject(thread,10000);DWORD code=0xffffffff;if(wait==WAIT_OBJECT_0)GetExitCodeThread(thread,&code);CloseHandle(thread);return wait==WAIT_OBJECT_0&&(bootstrap?code==0:code!=0xc0000005);
}
static bool inject(HANDLE process,DWORD pid){
 const auto dll=ownDir+L"\\native-clock.dll";
 // The installation receipt pins the independently built adapter; never load a substituted file.
 std::ifstream hashFile(ownDir+L"\\adapter.sha256");std::string expected;hashFile>>expected;if(expected.size()!=64||sha256(dll)!=expected){logEvent("adapter-hash-fallback",pid);return false;}
 auto remote=remoteModule(pid,dll,true);
 if(!remote){
   const auto localProc=GetProcAddress(GetModuleHandleW(L"kernel32.dll"),"LoadLibraryW");HMODULE owner=nullptr;
   if(!localProc||!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS|GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,(LPCWSTR)localProc,&owner))return false;
   const auto ownerPath=modulePath(owner),ownerName=ownerPath.substr(ownerPath.find_last_of(L"\\/")+1);const auto ownerRemote=remoteModule(pid,ownerName);
   if(!ownerRemote)return false;const auto remoteLoad=ownerRemote+((uintptr_t)localProc-(uintptr_t)owner);
   const auto bytes=(dll.size()+1)*sizeof(wchar_t);void* memory=VirtualAllocEx(process,nullptr,bytes,MEM_COMMIT|MEM_RESERVE,PAGE_READWRITE);if(!memory)return false;
   SIZE_T written=0;if(!WriteProcessMemory(process,memory,dll.c_str(),bytes,&written)||written!=bytes){VirtualFreeEx(process,memory,0,MEM_RELEASE);return false;}
   // On timeout preserve the remote string until process exit: a running loader may still read it.
   if(!remoteCall(process,remoteLoad,memory))return false;
   VirtualFreeEx(process,memory,0,MEM_RELEASE);remote=remoteModule(pid,dll,true);if(!remote)return false;
 }
 HMODULE local=LoadLibraryExW(dll.c_str(),nullptr,DONT_RESOLVE_DLL_REFERENCES);if(!local)return false;
 auto bootstrap=GetProcAddress(local,"RhClockBootstrap");const auto offset=(uintptr_t)bootstrap-(uintptr_t)local;FreeLibrary(local);if(!bootstrap)return false;
 return remoteCall(process,remote+offset,nullptr,true);
}
static std::vector<std::wstring> enabled(){std::ifstream f(ownDir+L"\\enabled.txt");std::string line;std::vector<std::wstring> names;while(std::getline(f,line)){if(!line.empty()&&line.back()=='\r')line.pop_back();names.emplace_back(line.begin(),line.end());}return names;}
static void scan(std::map<DWORD,unsigned long long>& seen,const std::vector<std::wstring>& allowed){
 DWORD ownSession=0;ProcessIdToSessionId(GetCurrentProcessId(),&ownSession);HANDLE snap=CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS,0);if(snap==INVALID_HANDLE_VALUE)return;
 PROCESSENTRY32W entry{};entry.dwSize=sizeof(entry);std::map<DWORD,unsigned long long> alive;
 if(Process32FirstW(snap,&entry))do{
   const Product* p=nullptr;for(const auto& candidate:products)if(std::find(allowed.begin(),allowed.end(),candidate.name)!=allowed.end()&&std::wstring(entry.szExeFile)==std::wstring(candidate.name)+L" Standalone.x64.exe")p=&candidate;if(!p)continue;
   DWORD session=0;if(!ProcessIdToSessionId(entry.th32ProcessID,&session)||session!=ownSession)continue;
   HANDLE process=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|PROCESS_QUERY_INFORMATION|PROCESS_VM_READ|PROCESS_VM_WRITE|PROCESS_VM_OPERATION|PROCESS_CREATE_THREAD|SYNCHRONIZE,FALSE,entry.th32ProcessID);if(!process)continue;
   FILETIME created,exit,kernel,user,now;wchar_t filename[32768];DWORD count=32768;
   if(!sameUser(process)||!GetProcessTimes(process,&created,&exit,&kernel,&user)||!QueryFullProcessImageNameW(process,0,filename,&count)){CloseHandle(process);continue;}
   const auto stamp=((unsigned long long)created.dwHighDateTime<<32)|created.dwLowDateTime;alive[entry.th32ProcessID]=stamp;
   GetSystemTimeAsFileTime(&now);const auto nowStamp=((unsigned long long)now.dwHighDateTime<<32)|now.dwLowDateTime;
   if(nowStamp-stamp<30000000ULL||seen[entry.th32ProcessID]==stamp){CloseHandle(process);continue;}
   const auto known=recognize(filename);
   if(!known){logEvent("unsupported-build-fallback",entry.th32ProcessID);seen[entry.th32ProcessID]=stamp;CloseHandle(process);continue;}
   if(!remoteModule(entry.th32ProcessID,known->engine)){CloseHandle(process);continue;}
   const auto ok=inject(process,entry.th32ProcessID);logEvent(ok?"bootstrap-requested":"injection-fallback",entry.th32ProcessID,ok?0:GetLastError());seen[entry.th32ProcessID]=stamp;CloseHandle(process);
 }while(Process32NextW(snap,&entry));CloseHandle(snap);
 for(auto it=seen.begin();it!=seen.end();){if(!alive.count(it->first))it=seen.erase(it);else ++it;}
}
int WINAPI wWinMain(HINSTANCE,HINSTANCE,PWSTR,int){
 ownDir=folder(modulePath());int argc=0;auto argv=CommandLineToArgvW(GetCommandLineW(),&argc);
 const bool once=argc==3&&std::wstring(argv[1])==L"--once";
 if(argc==2&&std::wstring(argv[1])==L"--stop-watcher"){auto event=OpenEventW(EVENT_MODIFY_STATE,FALSE,L"Local\\RabbitHole.NativeClock.Stop.v1");if(event){SetEvent(event);CloseHandle(event);}LocalFree(argv);return 0;}
 if(!(argc==1||once)){LocalFree(argv);return 2;}
 const std::vector<std::wstring> selection=once?std::vector<std::wstring>{argv[2]}:enabled();LocalFree(argv);
 HANDLE mutex=nullptr,stop=nullptr;
 if(!once){mutex=CreateMutexW(nullptr,TRUE,L"Local\\RabbitHole.NativeClock.Watcher.v1");if(!mutex||GetLastError()==ERROR_ALREADY_EXISTS){if(mutex)CloseHandle(mutex);return 0;}stop=CreateEventW(nullptr,TRUE,FALSE,L"Local\\RabbitHole.NativeClock.Stop.v1");if(!stop){CloseHandle(mutex);return 3;}ResetEvent(stop);}
 logEvent("watcher-start",GetCurrentProcessId());std::map<DWORD,unsigned long long> seen;
 do{scan(seen,selection);if(once)break;}while(WaitForSingleObject(stop,1000)==WAIT_TIMEOUT);
 logEvent("watcher-stop",GetCurrentProcessId());if(stop)CloseHandle(stop);if(mutex){ReleaseMutex(mutex);CloseHandle(mutex);}return 0;
}
