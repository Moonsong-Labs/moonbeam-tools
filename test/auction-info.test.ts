import { jest } from '@jest/globals';
import { calculateTimestamp, calculateCurrentLeasePeriod } from '../src/tools/auction-info';

describe('Auction Info Tests', () => {

    let api;

    beforeAll(async () => {
        api = {
            rpc: {
                chain: {
                    getHeader: jest.fn().mockReturnValue({
                        number: {
                            toNumber: jest.fn().mockReturnValue(100),
                        },
                    }) ,
                },
            },
            query: {
                timestamp: {
                    now: jest.fn().mockReturnValue({
                        toNumber: jest.fn().mockReturnValue(Date.now()),
                    }),
                },
            },
        };
    });

    test('calculateTimestamp should return correct future date', async () => {
        const futureBlock = 110;
        const [timestamp, date] = await calculateTimestamp(api, futureBlock);
        expect(date).toBeInstanceOf(Date);
        expect(timestamp).toBeGreaterThan(Date.now());
    });

    test('calculateCurrentLeasePeriod should return correct lease period', async () => {
        const leasePeriod = 10;
        const leaseOffset = 5;
        const currentLeasePeriod = await calculateCurrentLeasePeriod(api, leasePeriod, leaseOffset);
        expect(currentLeasePeriod).toBe((100 - leaseOffset) / leasePeriod);
    });
});