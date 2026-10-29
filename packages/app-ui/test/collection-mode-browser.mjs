// Browser qualification of the real compiled shared control. Boundary responses
// are synthetic; this is UI interruption/intent evidence, not conversion LAB E2E.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const req=createRequire(new URL('../../../package.json',import.meta.url));
const {chromium}=req('@playwright/test');
// Reuse the existing SDK fixture bundler; no new production dependency.
const {build}=createRequire(new URL('../../../runtime/packages/sdk/package.json',import.meta.url))('esbuild');
const {outputFiles}=await build({stdin:{contents:`import React from 'react';import {createRoot}from'react-dom/client';import {CollectionModeControl}from'./dist/CollectionModeControl.js';const api=async(path,body)=>{const r=await fetch(path,{method:body?'POST':'GET',headers:{'content-type':'application/json'},body:body&&JSON.stringify(body)});if(!r.ok)throw Error('unconfirmed');return r.json()};function App(){const[id,setId]=React.useState('one');window.fixtureSelect=setId;return React.createElement(CollectionModeControl,{collectionId:id,native:location.pathname==='/native',load:()=>api('/status/'+id),change:(target,request)=>api('/change',{target,request}),cancel:(target,request)=>api('/cancel',{target,request})})}createRoot(document.getElementById('root')).render(React.createElement(App));`,resolveDir:fileURLToPath(new URL('../',import.meta.url)),loader:'js'},bundle:true,format:'iife',platform:'browser',write:false});
const bundle=outputFiles[0].text,browser=await chromium.launch({headless:true});
const base=(mode='cloud_copy',change=null)=>({current_mode:mode,execution_available:true,change});
try{for(const native of [false,true]){
 let state=base(),post=async()=>({phase:'waiting_for_device'}),calls=[];
 const page=await browser.newPage();
 await page.route('https://mode.fixture/**',async route=>{const url=new URL(route.request().url());let body;
  if(url.pathname==='/fixture.js')return route.fulfill({contentType:'text/javascript',body:bundle});
  if(['/native','/portal'].includes(url.pathname))return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/fixture.js"></script>'});
  if(url.pathname.startsWith('/status/'))body=state;
  else if(url.pathname==='/change'){const input=route.request().postDataJSON();calls.push(input);const result=await post(input);if(result.error)return route.fulfill({status:503,body:'unknown'});body=result;}
  else if(url.pathname==='/cancel'){state=base();body={phase:'cancelled'};}
  else throw Error('unexpected fixture request');
  return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
 });
 const open=()=>page.goto('https://mode.fixture/'+(native?'native':'portal'));
 state={...base(),execution_available:false};await open();await page.waitForTimeout(30);assert.equal(await page.getByRole('button').count(),0);
 state=base();await open();await page.getByRole('button',{name:'Make private',exact:true}).waitFor();
 post=async input=>{state=base('cloud_copy',{request_id:input.request,target_mode:input.target,phase:'waiting_for_device'});return{phase:'waiting_for_devices',devices:['[test] Older capability device: 99999999-9999-4999-8999-999999999999']}};
 await page.getByRole('button',{name:'Make private',exact:true}).click();await page.getByText(/Older capability device:/).waitFor();
 assert.equal(await page.getByRole('button',{name:'Continue on this device'}).count(),native?1:0);
 assert.equal(await page.getByText('Private',{exact:true}).count(),0,'blocker must not claim Private');
 await page.getByRole('button',{name:'Cancel switch'}).click();await page.getByRole('button',{name:'Make private',exact:true}).waitFor();
 // A lost intent reply cannot complete optimistically; exact request survives retry.
 calls=[];post=async()=>({error:true});await page.getByRole('button',{name:'Make private',exact:true}).click();await page.getByRole('alert').waitFor();
 post=async input=>{state=base('cloud_copy',{request_id:input.request,target_mode:input.target,phase:'waiting_for_token_expiry',retry_at:'2099-01-01T00:00:00Z'});return{phase:'waiting_for_token_expiry',retry_at:'2099-01-01T00:00:00Z'}};
 await page.getByRole('button',{name:'Make private',exact:true}).click();await page.locator('time').waitFor();assert.equal(calls[0].request,calls[1].request);
 const before=calls.length;await open();await page.locator('time').waitFor();assert.equal(calls.length,before,'reload records no source gesture');
 if(native){post=async()=>{state=base('private');return{phase:'complete'}};await page.getByRole('button',{name:'Continue on this device'}).click();}else{state=base('private');await page.getByRole('button',{name:'Refresh status'}).click();}
 await page.getByText('Private',{exact:true}).waitFor();
 post=async input=>{state=base('private',{request_id:input.request,target_mode:input.target,phase:'finishing'});return{phase:'finishing'}};
 await page.getByRole('button',{name:'Turn on Cloud copy',exact:true}).click();await page.getByRole('status').waitFor();assert.equal(await page.getByText('Cloud copy',{exact:true}).count(),0,'intent alone does not claim Cloud');
 if(native){post=async()=>{state=base();return{phase:'complete'}};await page.getByRole('button',{name:'Continue on this device'}).click();}else{state=base();await page.getByRole('button',{name:'Refresh status'}).click();}
 await page.getByRole('button',{name:'Make private',exact:true}).waitFor();await page.close();console.log('PASS:',native?'native adapter':'portal intent adapter','hidden executor, named blocker, cancellation, exact-id uncertain retry, reload, token drain and both direction completion');
}}finally{await browser.close();}
