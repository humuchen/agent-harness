process.env.AH_CRYPTO_KEY='0'.repeat(64);
process.env.PORT='4567';
process.env.UI_CORS_ORIGIN='';
process.env.AUTH_PROVIDER='token';
const http = require('http');
const { spawn } = require('child_process');
const srv = spawn('node', ['dist/server.js'], { env: process.env, stdio: ['ignore','pipe','pipe'] });
let up=false;
const wait = ms => new Promise(r=>setTimeout(r,ms));
function req(method, path, body, headers){
  return new Promise((resolve,reject)=>{
    const data = body?JSON.stringify(body):null;
    const r = http.request({host:'127.0.0.1',port:4567,path,method,headers:Object.assign({'content-type':'application/json'},headers||{})}, res=>{
      let buf='';res.on('data',d=>buf+=d);res.on('end',()=>resolve({status:res.statusCode,setCookie:res.headers['set-cookie'],body:buf}));
    });
    r.on('error',reject); if(data)r.write(data); r.end();
  });
}
(async()=>{
  for(let i=0;i<40;i++){ try{ await req('GET','/api/auth/config'); up=true; break;}catch(e){ await wait(250);} }
  if(!up){ console.log('server did not start'); srv.kill(); process.exit(1);}
  const reg = await req('POST','/api/account/register',{username:'alice',password:'password123'});
  console.log('REGISTER', reg.status, reg.body, 'cookie?', !!reg.setCookie);
  const dup = await req('POST','/api/account/register',{username:'alice',password:'password123'});
  console.log('DUP', dup.status, dup.body);
  const bad = await req('POST','/api/account/register',{username:'bob',password:'123'});
  console.log('BADPW', bad.status, bad.body);
  const login = await req('POST','/api/account/login',{username:'alice',password:'password123'});
  console.log('LOGIN', login.status, login.body, 'cookie?', !!login.setCookie);
  const cookie = login.setCookie && login.setCookie[0].split(';')[0];
  const wrong = await req('POST','/api/account/login',{username:'alice',password:'nope'});
  console.log('WRONG', wrong.status, wrong.body);
  if(cookie){
    const auth = await req('GET','/api/sessions', null, {cookie, 'x-ah-username':'alice'});
    console.log('AUTHED', auth.status, auth.body.slice(0,60));
    const mismatch = await req('GET','/api/sessions', null, {cookie, 'x-ah-username':'mallory'});
    console.log('MISMATCH', mismatch.status, mismatch.body.slice(0,60));
    const nouser = await req('GET','/api/sessions', null, {cookie});
    console.log('NOUSERHDR', nouser.status, nouser.body.slice(0,60));
  }
  const noauth = await req('GET','/api/sessions', null, {});
  console.log('NOAUTH', noauth.status, noauth.body.slice(0,60));
  srv.kill(); process.exit(0);
})();
