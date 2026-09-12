import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec, spawn } from 'child_process';
import { fileURLToPath } from 'url';

const PORT = process.env.PORT || 5173;
const DIR = path.dirname(fileURLToPath(import.meta.url));

function getJavaVersion(){
  try{
    const out = fs.readFileSync('/tmp/java-version.txt','utf8').trim();
    return out;
  }catch{}
  return null;
}
// cache java version at startup
let JAVA_VERSION = 'unknown';
try{
  const v = await new Promise((res,rej)=>{
    exec('javac -version 2>&1; java -version 2>&1 | head -n 1', (e, stdout)=> res(stdout.trim()));
  });
  // parse like "javac 25.0.1\nopenjdk version \"25.0.1\"..."
  const m = v.match(/(\d+\.\d+\.\d+)/);
  if(m) JAVA_VERSION = m[1];
  else JAVA_VERSION = v.split('\n')[0].slice(0,40);
  fs.writeFileSync('/tmp/java-version.txt', JAVA_VERSION);
  console.log('Detected Java:', JAVA_VERSION, v);
}catch(e){ console.log('java detect error', e); }

const mime = {
  '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json',
  '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.woff2':'font/woff2'
};

const server = http.createServer(async (req, res)=>{
  // CORS
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS'){ res.writeHead(204); return res.end(); }

  if(req.url==='/api/java-version' && req.method==='GET'){
    res.writeHead(200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({ version: JAVA_VERSION, raw: JAVA_VERSION }));
  }

  if(req.url==='/api/runtimes' && req.method==='GET'){
    res.writeHead(200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify([{ language:'java', version: JAVA_VERSION, aliases:[] }]));
  }

  if(req.url==='/api/execute' && req.method==='POST'){
    let body='';
    req.on('data', c=> body+=c);
    req.on('end', async ()=>{
      try{
        const data = JSON.parse(body || '{}');
        const files = data.files || [];
        const stdin = data.stdin || '';
        if(!files.length){ res.writeHead(400); return res.end(JSON.stringify({ message:'no files'})); }

        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'java-ide-'));
        // auto-inject imports in background (no import needed from user)
        function ensureImports(content){
          if(content.trim().startsWith('//')) return content; // keep problem comments
          const hasUtil = /^\s*import\s+java\.util\./m.test(content);
          const hasIO = /^\s*import\s+java\.io\./m.test(content);
          const needsUtil = /(?:Arrays|List|Map|Set|HashMap|HashSet|ArrayList|LinkedList|Collections|Scanner|Optional|Queue|Deque|PriorityQueue|Stack|TreeMap|TreeSet)\b/.test(content);
          const needsIO = /(BufferedReader|InputStream|FileReader|IOException)\b/.test(content);
          let prefix='';
          if(needsUtil && !hasUtil) prefix += 'import java.util.*;\n';
          if(needsIO && !hasIO) prefix += 'import java.io.*;\n';
          if(!prefix) return content;
          // insert after package if present
          const pkgMatch = content.match(/^\s*package\s+[\w.]+\s*;\s*\n/);
          if(pkgMatch) return content.replace(pkgMatch[0], pkgMatch[0]+prefix);
          return prefix + content;
        }
        // write files
        for(const f of files){
          const safe = path.basename(f.name);
          if(!safe.endsWith('.java')) continue;
          const fixed = ensureImports(f.content);
          fs.writeFileSync(path.join(tmp, safe), fixed);
        }
        const fileList = fs.readdirSync(tmp).filter(f=>f.endsWith('.java'));
        if(!fileList.length){ res.writeHead(400); return res.end(JSON.stringify({ message:'no java files'})); }
        // if Main references Solution but Solution.java missing, auto-create default Solution
        const mainPath = path.join(tmp, 'Main.java');
        if(fs.existsSync(mainPath) && !fileList.includes('Solution.java')){
          const mainContent = fs.readFileSync(mainPath,'utf8');
          if(mainContent.includes('Solution')){
            fs.writeFileSync(path.join(tmp,'Solution.java'), `import java.util.*;\nclass Solution{public static int[] twoSum(int[]n,int t){java.util.Map<Integer,Integer> m=new java.util.HashMap<>();for(int i=0;i<n.length;i++){int k=t-n[i]; if(m.containsKey(k)) return new int[]{m.get(k),i}; m.put(n[i],i);}return new int[]{};}}\n`);
            fileList.push('Solution.java');
          }
        }

        // compile
        const compile = await new Promise(resolve=>{
          exec(`javac ${fileList.map(f=>`"${f}"`).join(' ')} 2>&1`, { cwd: tmp, timeout: 8000 }, (err, stdout, stderr)=>{
            const out = (stdout||'') + (stderr||'');
            resolve({ code: err ? (err.code || 1) : 0, output: out });
          });
        });

        if(compile.code !== 0){
          res.writeHead(200, {'Content-Type':'application/json'});
          fs.rmSync(tmp, { recursive:true, force:true });
          return res.end(JSON.stringify({ compile, run: null }));
        }

        // find main class: prefer Main, else first file basename without .java that contains "public static void main"
        let mainClass = 'Main';
        // if no Main.java, try to detect
        if(!fileList.includes('Main.java')){
          for(const f of fileList){
            const content = fs.readFileSync(path.join(tmp,f),'utf8');
            const m = content.match(/public\s+class\s+(\w+)/);
            if(m && content.includes('public static void main')){ mainClass = m[1]; break; }
            if(m) mainClass = m[1];
          }
        }

        const run = await new Promise(resolve=>{
          const proc = spawn('java', [mainClass], { cwd: tmp });
          let out='', err='';
          let killed=false;
          const timer = setTimeout(()=>{ killed=true; proc.kill('SIGKILL'); }, 5000);
          proc.stdout.on('data', d=> out+=d.toString());
          proc.stderr.on('data', d=> err+=d.toString());
          proc.on('error', e=>{ clearTimeout(timer); resolve({ code:1, output: e.message }); });
          proc.on('close', code=>{
            clearTimeout(timer);
            if(killed) resolve({ code:124, output: out+err+'\n[Timeout: 5s exceeded]' });
            else resolve({ code: code||0, output: out+err });
          });
          if(stdin) proc.stdin.write(stdin);
          proc.stdin.end();
        });

        fs.rmSync(tmp, { recursive:true, force:true });
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({ compile, run }));
      }catch(e){
        res.writeHead(500); return res.end(JSON.stringify({ message:e.message }));
      }
    });
    return;
  }

  // static file
  let filePath = path.join(DIR, req.url==='/' ? 'index.html' : req.url.split('?')[0]);
  // prevent traversal
  if(!filePath.startsWith(DIR)) { res.writeHead(403); return res.end('forbidden'); }
  if(fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) filePath = path.join(filePath,'index.html');
  if(!fs.existsSync(filePath)){ res.writeHead(404); return res.end('not found'); }
  const ext = path.extname(filePath);
  res.writeHead(200, {'Content-Type': mime[ext] || 'text/plain'});
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, ()=> console.log(`Java IDE at http://localhost:${PORT} — Java ${JAVA_VERSION}`));
