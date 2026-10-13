#pragma once
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <bcrypt.h>
#include <string>
#include <vector>
#include <fstream>
#include <sstream>
#include <algorithm>
#include <cmath>
struct Product {const wchar_t *name,*engine;const char *hostHash,*engineHash;};
static const Product products[]={
 {L"WhiteCap",L"WhiteCap.x64.dll","932a406cbff66e270a06de77f806450aa25bbdf02fb9aaeb4a84995f50fb500d","bce889bec7c9b9698f51a8f3d7f4ad9ebe19325d649f8e9e1073b334007ce37f"},
 {L"Aeon",L"Arcade.x64.dll","e950a3f34b9f9ecc819cb070b25ae7464674632c5207ca0dbde04c1ba408d4a6","9eff2c78258a3a594271ac60004be88e9c5e02df630b546b1ce5237f3c6c442e"},
 {L"G-Force",L"G-Force.x64.dll","9e7b676ab98fd58ff30a08de9a174ad2ba6fe5283c5ff76249426ba2509bea72","eb03a30aac9577ef6b090e4d96804fee98034f5300834ab92b105c91d062c510"}
};
static std::wstring env(const wchar_t* name){wchar_t b[32768]{};const auto n=GetEnvironmentVariableW(name,b,32768);return n&&n<32768?b:L"";}
static std::wstring modulePath(HMODULE m=nullptr){wchar_t b[32768]{};auto n=GetModuleFileNameW(m,b,32768);return n&&n<32768?b:L"";}
static std::wstring folder(const std::wstring& p){return p.substr(0,p.find_last_of(L"\\/"));}
static std::wstring hostPath(const Product& p){return env(L"ProgramFiles(x86)")+L"\\SoundSpectrum\\"+p.name+L"\\"+p.name+L" Standalone.x64.exe";}
static std::wstring finalPath(const std::wstring& file){HANDLE f=CreateFileW(file.c_str(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,0,nullptr);if(f==INVALID_HANDLE_VALUE)return {};wchar_t value[32768];auto n=GetFinalPathNameByHandleW(f,value,32768,FILE_NAME_NORMALIZED);CloseHandle(f);return n&&n<32768?value:L"";}
static bool sameFile(const std::wstring& a,const std::wstring& b){const auto x=finalPath(a),y=finalPath(b);return !x.empty()&&!y.empty()&&!_wcsicmp(x.c_str(),y.c_str());}
static std::string sha256(const std::wstring& file){
 HANDLE f=CreateFileW(file.c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,0,nullptr);if(f==INVALID_HANDLE_VALUE)return {};
 BCRYPT_ALG_HANDLE alg=nullptr;BCRYPT_HASH_HANDLE hash=nullptr;std::string result;unsigned char digest[32],buf[65536];DWORD n=0;
 if(BCryptOpenAlgorithmProvider(&alg,BCRYPT_SHA256_ALGORITHM,nullptr,0)>=0&&BCryptCreateHash(alg,&hash,nullptr,0,nullptr,0,0)>=0){
   bool ok=true;for(;;){if(!ReadFile(f,buf,sizeof(buf),&n,nullptr)){ok=false;break;}if(!n)break;if(BCryptHashData(hash,buf,n,0)<0){ok=false;break;}}
   if(ok&&BCryptFinishHash(hash,digest,sizeof(digest),0)>=0){const char* hex="0123456789abcdef";for(auto b:digest){result+=hex[b>>4];result+=hex[b&15];}}
 }
 if(hash)BCryptDestroyHash(hash);if(alg)BCryptCloseAlgorithmProvider(alg,0);CloseHandle(f);return result;
}
static const Product* recognize(const std::wstring& file){for(const auto& p:products)if(sameFile(file,hostPath(p))&&sha256(file)==p.hostHash&&sha256(folder(file)+L"\\"+p.engine)==p.engineHash)return &p;return nullptr;}
[[maybe_unused]] static unsigned configuredFps(const Product& p){
 const auto file=env(L"APPDATA")+L"\\SoundSpectrum\\"+p.name+L"\\Preferences (Standalone).txt";
 std::ifstream in(file,std::ios::binary);std::string bytes((std::istreambuf_iterator<char>(in)),{});if(bytes.empty()||bytes.size()>1048576)return 0;
 std::wstring text;if(bytes.size()>2&&(unsigned char)bytes[0]==255&&(unsigned char)bytes[1]==254){for(size_t i=2;i+1<bytes.size();i+=2)text+=(wchar_t)((unsigned char)bytes[i]|((unsigned char)bytes[i+1]<<8));}else text.assign(bytes.begin(),bytes.end());
 std::wistringstream lines(text);std::wstring line;unsigned fps=0,count=0;
 while(std::getline(lines,line)){auto at=line.find_first_not_of(L" \t\r");if(at==std::wstring::npos)continue;line.erase(0,at);const std::wstring key=L"Graphics.TargetFrameRate";if(line.compare(0,key.size(),key))continue;auto eq=line.find(L'=');if(eq==std::wstring::npos)continue;const auto lhs=line.substr(0,eq);if(lhs.find_first_not_of(L" \t",key.size())!=std::wstring::npos)continue;wchar_t* end=nullptr;double x=wcstod(line.c_str()+eq+1,&end);if(!std::isfinite(x)||x<1||x>240||x!=(unsigned)x)return 0;while(*end==L' '||*end==L'\t'||*end==L'\r')end++;if(*end)return 0;fps=(unsigned)x;count++;}
 return count==1?fps:0;
}
