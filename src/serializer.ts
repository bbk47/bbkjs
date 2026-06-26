import { encrypt } from '@bbk47/toolbox';
import type { Frame } from './protocol/index';
import { encode, decode } from './protocol/index';

export interface Serializer {
    serialize(frame: Frame): Buffer;
    derialize(binarydata: Buffer): Frame;
}

export default function serializerFactory(password: string, method: string): Serializer {
    const encryptWorker = new encrypt.Encryptor(password, method as encrypt.CipherMethod);
    return {
        serialize(frame: Frame): Buffer {
            const dataBytes = encode(frame);
            return encryptWorker.encrypt(dataBytes) as Buffer;
        },
        derialize(binarydata: Buffer): Frame {
            const decrypted = encryptWorker.decrypt(binarydata) as Buffer;
            return decode(decrypted);
        },
    };
}
