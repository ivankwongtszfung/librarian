// Cucumber must have the TS loader registered before it imports step definitions.
import { register } from 'tsx/esm/api';

register();
