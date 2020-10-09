import { Account } from 'js-conflux-sdk';

const privateKey = process.env.RELAYER_PK;
const account = new Account(privateKey);

export default account;
