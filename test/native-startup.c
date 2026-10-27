#define _GNU_SOURCE
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/resource.h>
#define MS __attribute__((ms_abi))
static int libraries,resolved;
static uint16_t U16(const void *p){uint16_t n;memcpy(&n,p,2);return n;}
static uint32_t U32(const void *p){uint32_t n;memcpy(&n,p,4);return n;}
static uint64_t U64(const void *p){uint64_t n;memcpy(&n,p,8);return n;}
static void Fail(const char *s){fprintf(stderr,"%s\n",s);exit(2);}
static void *MS Library(const uint16_t *name){
 const char *names[]={"kernel32.dll","user32.dll","shell32.dll","ole32.dll"};
 if(libraries>=4)Fail("Extra DLL load");
 const char *expected=names[libraries];size_t i=0;
 while(expected[i]){if(name[i]!=(unsigned char)expected[i])Fail("Invalid DLL name");i++;}
 if(name[i])Fail("Invalid DLL suffix");return (void*)(uintptr_t)++libraries;
}
static int MS Initialized(void *reserved,uint32_t mode){
 if(reserved||mode!=2||libraries!=4||resolved<40)Fail("Initialization incomplete");
 printf("Native entry and %d API bindings reached the first COM initialization call (mock Win32).\n",resolved);exit(0);
}
static void MS Unexpected(void){Fail("Unexpected API invocation");}
static void *MS Address(void *module,const char *name){
 if((uintptr_t)module<1||(uintptr_t)module>4||!name||!*name)Fail("Invalid API lookup");
 resolved++;return !strcmp(name,"CoInitializeEx")?(void*)Initialized:(void*)Unexpected;
}
int main(int argc,char **argv){
 if(argc!=2)Fail("Specify a generated EXE");struct rlimit limit={0,0};setrlimit(RLIMIT_CORE,&limit);
 FILE *f=fopen(argv[1],"rb");if(!f)Fail("Cannot open EXE");fseek(f,0,SEEK_END);long n=ftell(f);rewind(f);
 unsigned char *b=malloc(n);if(!b||fread(b,1,n,f)!=(size_t)n)Fail("Cannot read EXE");fclose(f);
 uint32_t h=U32(b+0x3c);unsigned char *o=b+h+24;if(U16(o)!=0x20b)Fail("PE32+ required");
 uint32_t size=U32(o+56);unsigned char *image=mmap(0,size,7,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);if(image==MAP_FAILED)Fail("Cannot map image");memcpy(image,b,U32(o+60));
 unsigned char *s=o+U16(b+h+20);
 for(int i=0;i<U16(b+h+6);i++,s+=40){uint32_t rva=U32(s+12),count=U32(s+16),raw=U32(s+20);if((uint64_t)rva+count>size||(uint64_t)raw+count>(size_t)n)Fail("Invalid section");if(raw&&count)memcpy(image+rva,b+raw,count);}
 uint32_t reloc=U32(o+152),relocSize=U32(o+156);
 for(uint32_t at=reloc;at<reloc+relocSize;){uint32_t page=U32(image+at),block=U32(image+at+4);if(block<8)Fail("Invalid relocation");for(uint32_t i=8;i<block;i+=2){uint16_t e=U16(image+at+i);if(e>>12==10){uint64_t v=U64(image+page+(e&4095))+(uintptr_t)image-U64(o+24);memcpy(image+page+(e&4095),&v,8);}else if(e>>12)Fail("Unsupported relocation");}at+=block;}
 for(unsigned char *d=image+U32(o+120);U32(d);d+=20){if(strcmp((char*)image+U32(d+12),"kernel32.dll"))Fail("Unexpected DLL");uint32_t lookup=U32(d),iat=U32(d+16);for(int i=0;U64(image+lookup+i*8);i++){char *name=(char*)image+U64(image+lookup+i*8)+2;void *target=0;if(!strcmp(name,"LoadLibraryW"))target=Library;if(!strcmp(name,"GetProcAddress"))target=Address;if(!strcmp(name,"ExitProcess"))target=Unexpected;if(!target)Fail("Unexpected import");memcpy(image+iat+i*8,&target,8);}}
 // 自作EXEの機械語を実行する。Windows APIは副作用のない模擬関数へ接続する。
 void (MS *entry)(void)=(void*)(image+U32(o+16));entry();Fail("Unexpected entry return");
}
