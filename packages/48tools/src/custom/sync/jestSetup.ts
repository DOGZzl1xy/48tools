import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';

/**
 * 测试用（jest.config.cjs 的 setupFiles）：本机有内容包的源文件（../private）时，每个测试文件开始前装上它，
 * 这样平时跑测试，测的就是自己实际在用的那一份；CUSTOM_BASIC=true 时不装，测程序自带的。
 */
const entry: string = path.join(__dirname, '../private/pack.ts');

// 源文件的入口自己会调 installPack
if (process.env.CUSTOM_BASIC !== 'true' && fs.existsSync(entry)) require(entry);
