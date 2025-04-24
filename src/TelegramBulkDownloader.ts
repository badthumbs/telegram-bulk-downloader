import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import fs from 'fs';
import path from 'path';
import inquirer from 'inquirer';
import Byteroo, { Container } from 'byteroo';
import { Entity } from 'telegram/define';
import extractDisplayName from './helpers/extractDisplayName';
import ask from './helpers/ask';
import JsonSerializer from './helpers/JsonSerializer';
import checkbox from '@inquirer/checkbox';
import getInputFilter from './helpers/getInputFilter';
import getFilenameExtension from './helpers/getFilenameExtension';
import MediaType from './types/MediaType';
import { LogLevel } from 'telegram/extensions/Logger';
import cliProgress from 'cli-progress';
import pLimit from 'p-limit';

class TelegramBulkDownloader {
  private storage: Byteroo;
  private credentials: Container;
  private state: Container;
  isDownloading: boolean;
  private SIGINT: boolean;
  private client?: TelegramClient;

  constructor() {
    this.storage = new Byteroo({ name: 'TelegramBulkDownloader', autocommit: true });
    this.credentials = this.storage.getContainerSync('credentials') as Container;
    this.state = this.storage.getContainerSync('state') as Container;
    this.isDownloading = false;
    this.SIGINT = false;
  }

  private async newDownload() {
    if (!this.client) throw new Error('TelegramClient undefined');
    const query = await inquirer.prompt([{ name: 'id', message: 'Bitte Benutzername oder Chat-ID eingeben:' }]);

    try {
      const res = await this.client.getEntity(query.id);
      const { metadata } = await inquirer.prompt([{ name: 'metadata', message: 'Metadaten einbinden? (Empfohlen: nein)', type: 'confirm' }]);
      let mediaTypes: MediaType[] = [];
      while (mediaTypes.length <= 0) {
        mediaTypes = await checkbox({
          message: 'Wähle Medientypen:',
          choices: [
            { name: 'Bilder', value: 'InputMessagesFilterPhotos' },
            { name: 'Videos', value: 'InputMessagesFilterVideo' },
            { name: 'Dokumente', value: 'InputMessagesFilterDocument' },
            { name: 'Musik', value: 'InputMessagesFilterMusic' },
            { name: 'Sprachnachrichten', value: 'InputMessagesFilterVoice' },
            { name: 'GIFs', value: 'InputMessagesFilterGif' },
          ],
        });
      }
      const outPath = await ask('Ordnerpfad für Dateien:' );
      this.state.set(res.id.toString(), {
        displayName: extractDisplayName(res),
        entityJson: res.toJSON(),
        outPath: path.resolve(outPath),
        metadata,
        mediaTypes: mediaTypes.map(e => ({ type: e, offset: 0 })),
        originalId: query.id,
      });
      await this.download(res);
    } catch (err) {
      console.error('Fehler beim Abrufen des Chats', err);
      this.main();
    }
  }

  private async download(entity: Entity) {
    if (!this.client) throw new Error('TelegramClient undefined');
    const id = entity.id.toString();

    for (const mediaType of this.state.get(id).mediaTypes) {
      await this.downloadMediaType(entity, mediaType.type);
    }

    this.state.remove(id);
    await this.state.commit();
    process.exit(0);
  }

  private async downloadMediaType(entity: Entity, mediaType: MediaType) {
    if (!this.client) throw new Error('TelegramClient undefined');
    this.isDownloading = true;
    const id = entity.id.toString();
    const latest = await this.client.getMessages(entity, { limit: 1 });
    this.state.set(id, { ...this.state.get(id), limit: latest[0].id });

    const metaOpt = this.state.get(id).metadata;
    let jsonSerializer;
    if (metaOpt) {
      jsonSerializer = new JsonSerializer(path.join(this.state.get(id).outPath, 'metadata.json'));
    }

    while (true) {
      let offset = this.state.get(id).mediaTypes.find((e:any) => e.type === mediaType).offset;
      const msgs = await this.client.getMessages(entity, {
        limit: 1000,
        offsetId: offset,
        reverse: true,
        filter: getInputFilter(mediaType),
      });

      const downloadDir = this.state.get(id).outPath;
      if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

      // bis zu 15 parallele Downloads
      const limit = pLimit(15);
      const tasks: Promise<void>[] = [];

      for (const msg of msgs) {
        tasks.push(limit(async () => {
          const bar = new cliProgress.SingleBar({ format: `${msg.id}.${getFilenameExtension(msg)} | {bar} {percentage}% | ETA: {eta}s` }, cliProgress.Presets.shades_classic);
          bar.start(100, 0);
          try {
            const buf = await this.client!.downloadMedia(msg, { progressCallback: (dl, tot) => bar.update(Math.round((dl as number)/(tot as number)*100)) });
            bar.update(100);
            const file = path.join(downloadDir, `${msg.id}.${getFilenameExtension(msg)}`);
            fs.writeFileSync(file, buf as any);
            if (jsonSerializer) await jsonSerializer.append(msg);
          } catch (err) {
            console.warn(`Fehler bei Nachricht ${msg.id}:`, err);
          } finally {
            bar.stop();
          }
        }))
      }
      await Promise.all(tasks);

      const lastId = msgs.length>0? msgs[msgs.length-1].id : offset;
      offset = msgs.length===0? offset+999 : lastId;
      this.state.set(id, { ...this.state.get(id), mediaTypes: this.state.get(id).mediaTypes.map((e:any) => e.type===mediaType? {...e,offset} : e) });

      if (this.SIGINT) {
        console.log(`Beende, SIGINT=${this.SIGINT}`);
        await this.client.disconnect();
        await this.client.destroy();
        await this.state.commit();
        process.exit(0);
      }
      if (offset >= this.state.get(id).limit) break;
    }
  }

  private async resume() {
    if (!this.client) throw new Error('TelegramClient undefined');
    const res = await inquirer.prompt({ name:'resume', type:'list', message:'Chat wählen', choices:[
      ...this.state.list().map(e=>({name:this.state.get(e).displayName||e,value:e})),
      {name:'Zurück',value:'back'}
    ]});
    if (res.resume==='back') return this.main();
    const ent = await this.client.getEntity(this.state.get(res.resume).entityJson.username||this.state.get(res.resume).originalId);
    this.download(ent);
  }

  async main() {
    let API_ID = this.credentials.get('API_ID');
    if (!API_ID) { API_ID=await ask('API_ID: '); this.credentials.set('API_ID',API_ID); }
    let API_HASH = this.credentials.get('API_HASH');
    if (!API_HASH) { API_HASH=await ask('API_HASH: ',{type:'password'}); this.credentials.set('API_HASH',API_HASH); }
    if (!this.client) {
      this.client = new TelegramClient(new StringSession(this.credentials.get('session')),parseInt(API_ID),API_HASH,{});
      this.client.setLogLevel(LogLevel.NONE);
    }
    if (this.client.disconnected) {
      await this.client.start({
        phoneNumber:ask.bind(undefined,'Telefonnummer: '),
        password:ask.bind(undefined,'Passwort: ',{type:'password'}),
        phoneCode:ask.bind(undefined,'Code: ',{type:'password'}),
        onError:(e)=>console.log(e)
      });
      this.credentials.set('session',await (this.client as any).session.save());
    }
    const menu = await inquirer.prompt({ name:'option',type:'list',message:'Option wählen',choices:[
      {name:'Neuer Download',value:'new'},
      {name:'Fortsetzen',value:'resume'},
      {name:'Beenden',value:'exit'}
    ]});
    switch(menu.option) {
      case 'exit': process.exit(0);
      case 'new': this.newDownload(); break;
      case 'resume': this.resume(); break;
    }
  }

  run() { this.main(); process.on('SIGINT',()=>{ console.log('Interrupt'); if(!this.isDownloading) process.exit(0); this.SIGINT=true; }); }
  getStoragePath(){ return this.storage.path; }
}

export default TelegramBulkDownloader;
