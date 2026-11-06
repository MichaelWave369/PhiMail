import { describe,it,expect } from 'vitest';
import {seedMessages,validateImportedMessages} from './demo.js';
describe('demo message validation',()=>{
 it('accepts the bundled synthetic mailbox',()=>expect(validateImportedMessages(seedMessages)).toHaveLength(seedMessages.length));
 it('rejects unknown folders',()=>expect(()=>validateImportedMessages([{...seedMessages[0],folder:'unknown'}])).toThrow('Invalid folder'));
 it('rejects repeated IDs',()=>expect(()=>validateImportedMessages([seedMessages[0],seedMessages[0]])).toThrow('Duplicate'));
 it('rejects oversize imports',()=>expect(()=>validateImportedMessages(Array(1001).fill(seedMessages[0]))).toThrow('1,000'));
 it('truncates overlong subject',()=>expect(validateImportedMessages([{...seedMessages[0],subject:'x'.repeat(800)}])[0].subject).toHaveLength(500));
});
