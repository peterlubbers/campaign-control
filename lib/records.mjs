import fs from 'node:fs/promises';
import path from 'node:path';
import {atomicJSONFile} from './workspaces.mjs';

// A record store is separate from the local media/materialization workspace.
// Hosted workers can implement read/write/list with a workspace-owned database.
export class FileSystemRecordStore {
  constructor(root,{io = fs,maxBytes = 16 * 1024 * 1024} = {}) {this.root=path.resolve(root);this.io=io;this.maxBytes=maxBytes;}
  file(key) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(key)) throw new Error('Invalid record identity.');
    return path.join(this.root,...key.split('/'))+'.json';
  }
  async read(key) {
    const file=this.file(key), stat=await this.io.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size>this.maxBytes) throw new Error('Private record is invalid or oversized.');
    return JSON.parse(await this.io.readFile(file,'utf8'));
  }
  async write(key,value) {
    if (Buffer.byteLength(JSON.stringify(value))>this.maxBytes) throw new Error('Private record is oversized.');
    return atomicJSONFile(this.file(key),value,{io:this.io});
  }
  async list(prefix='') {
    if (prefix && !/^[A-Za-z0-9_-]+$/.test(prefix)) throw new Error('Invalid record group.');
    try {return (await this.io.readdir(path.join(this.root,prefix))).filter(name=>/^[A-Za-z0-9_-]+\.json$/.test(name)).map(name=>name.slice(0,-5));}
    catch(error) {if(error.code==='ENOENT')return [];throw error;}
  }
}
