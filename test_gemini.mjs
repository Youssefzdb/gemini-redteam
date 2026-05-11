import https from 'node:https'
import querystring from 'node:querystring'

const inner = [['Reply with exactly: {"ok":true}',0,null,null,null,null,0],['en-US'],
  ['','','',null,null,null,null,null,null,''],'','',null,[0],1,null,null,1,0,
  null,null,null,null,null,[[0]],0]
const payload = querystring.stringify({'f.req':JSON.stringify([null,JSON.stringify(inner)])})+'&'

console.log('Testing...')
const req = https.request({
  hostname:'gemini.google.com',
  path:'/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
  method:'POST',
  headers:{
    'content-type':'application/x-www-form-urlencoded;charset=UTF-8',
    'content-length':Buffer.byteLength(payload),
    'x-same-domain':'1',
    'user-agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    'cookie':'','accept':'*/*',
  },timeout:30000,
},res=>{
  console.log('HTTP Status:', res.statusCode)
  let d=''
  res.on('data',c=>d+=c)
  res.on('end',()=>{
    console.log('Response length:', d.length)
    console.log('First 500 chars:')
    console.log(d.slice(0,500))
  })
})
req.on('error',e=>console.log('ERROR:',e.message,e.code))
req.on('timeout',()=>{req.destroy();console.log('TIMEOUT')})
req.write(payload);req.end()
