'use strict';
import { _ } from 'meteor/underscore';
import { Meteor } from 'meteor/meteor';
import { dbArena } from '/db/dbArena';
import { dbArenaFighters, MAX_MANNER_SIZE, getAttributeNumber } from '/db/dbArenaFighters';
import { dbArenaLog } from '/db/dbArenaLog';
import { dbCompanies } from '/db/dbCompanies';
import { dbLog } from '/db/dbLog';
import { debug } from '/server/imports/utils/debug';

export function startArenaFight() {
  console.log('start arena fight...');
  const lastArenaData = dbArena.findOne({}, {
    sort: {
      beginDate: -1
    },
    fields: {
      _id: 1,
      shuffledFighterCompanyIdList: 1
    }
  });

  const arenaId = lastArenaData._id;
  const shuffledFighterCompanyIdList = lastArenaData.shuffledFighterCompanyIdList;
  if (! shuffledFighterCompanyIdList || shuffledFighterCompanyIdList.length < 1) {
    dbArena.update(arenaId, {
      $set: {
        winnerList: [],
        endDate: new Date()
      }
    });

    return true;
  }
  const fighterHashByCompanyId = {};
  let allFighterTotalInvest = 0;
  const fighterListBySequence = dbArenaFighters
    .find(
      {
        arenaId: arenaId
      },
      {
        sort: {
          agi: -1,
          createdAt: 1
        }
      }
    )
    .map((arenaFighter) => {
      arenaFighter.totalInvest = (
        arenaFighter.hp +
        arenaFighter.sp +
        arenaFighter.atk +
        arenaFighter.def +
        arenaFighter.agi
      );
      allFighterTotalInvest += arenaFighter.totalInvest;
      arenaFighter.hp = getAttributeNumber('hp', arenaFighter.hp);
      arenaFighter.sp = getAttributeNumber('sp', arenaFighter.sp);
      arenaFighter.atk = getAttributeNumber('atk', arenaFighter.atk);
      arenaFighter.def = getAttributeNumber('def', arenaFighter.def);
      arenaFighter.agi = getAttributeNumber('agi', arenaFighter.agi);
      arenaFighter.currentHp = arenaFighter.hp;
      arenaFighter.currentSp = arenaFighter.sp;
      fighterHashByCompanyId[arenaFighter.companyId] = arenaFighter;

      return arenaFighter;
    });
  debug.log('startArenaFight', fighterListBySequence);
  //輸家companyId陣列，依倒下的順序排列
  const loser = [];
  //獲得收益的紀錄用hash
  const gainProfitHash = {};
  _.each(fighterListBySequence, (fighter) => {
    gainProfitHash[fighter.companyId] = 0;
  });
  const arenaLogBulk = dbArenaLog.create(arenaId);
  //log次序
  let sequence = 0;
  //回合數
  let round = 1;
  const maximumRound = Meteor.settings.public.arenaMaximumRound;
  //直到戰到剩下一人為止
  while (loser.length < fighterListBySequence.length - 1) {
    //超過十萬回合後自動中止
    if (round > maximumRound) {
      console.log(`round > maximum round ${maximumRound}!`);
      break;
    }
    //所有參賽者依序攻擊
    for (const attacker of fighterListBySequence) {
      //跳過已倒下參賽者的行動
      if (attacker.currentHp <= 0) {
        continue;
      }
      //依此攻擊者的攻擊優先順序取得防禦者
      let defender;
      for (const attackTargetIndex of attacker.attackSequence) {
        const companyId = shuffledFighterCompanyIdList[attackTargetIndex];
        defender = fighterHashByCompanyId[companyId];
        if (defender && defender.currentHp > 0) {
          break;
        }
      }
      if (! defender || defender.currentHp <= 0) {
        continue;
      }
      const arenaLog = {
        arenaId: arenaId,
        sequence: sequence,
        round: round,
        companyId: [attacker.companyId, defender.companyId],
        attackerSp: attacker.currentSp
      };
      //決定使用的招式
      arenaLog.attackManner = Math.floor((Math.random() * MAX_MANNER_SIZE) + 1);
      //決定使用特殊攻擊還是普通攻擊
      if (attacker.currentSp >= attacker.spCost) {
        const randomSp = Math.floor((Math.random() * 10) + 1);
        if (attacker.spCost >= randomSp) {
          attacker.currentSp -= attacker.spCost;
          arenaLog.attackManner *= -1;
        }
      }
      //決定造成的傷害
      arenaLog.damage = 0;
      //特殊攻擊時傷害等於攻擊者atk
      if (arenaLog.attackManner < 0) {
        arenaLog.damage = attacker.atk;
      }
      else {
        const randomAgi = Math.floor((Math.random() * 100) + 1);
        if (randomAgi > 95 || attacker.agi + randomAgi >= defender.agi) {
          arenaLog.damage = Math.max(attacker.atk - defender.def, 1);
        }
      }
      //若有造成傷害
      if (arenaLog.damage > 0) {
        defender.currentHp -= arenaLog.damage;
        // hp降到0或0以下則進入loser
        if (defender.currentHp <= 0) {
          loser.push(defender.companyId);
          //取得擊倒盈利＋擊倒獎勵
          const reward = defender.totalInvest + 5000;
          arenaLog.profit = reward;
          gainProfitHash[attacker.companyId] += reward;
        }
      }
      arenaLog.defenderHp = defender.currentHp;
      arenaLogBulk.insert(arenaLog);
      sequence += 1;
    }
    //回合結束，所有存活者回復一點sp
    _.each(fighterListBySequence, (fighter) => {
      if (fighter.currentHp > 0) {
        fighter.currentSp = Math.min(fighter.currentSp + 1, fighter.sp);
      }
    });
    round += 1;
  }
  //插入戰鬥紀錄
  if (fighterListBySequence.length > 1) {
    arenaLogBulk.execute();
  }
  //取得所有存活者
  const aliveList = _.filter(fighterListBySequence, (fighter) => {
    return fighter.currentHp > 0;
  });
  //取得最後贏家
  const sortedWinnerList = _.sortBy(aliveList, 'currentHp');
  const sortedWinnerIdList = _.pluck(sortedWinnerList, 'companyId');
  //取的排名列表
  const winnerList = sortedWinnerIdList.concat(loser.reverse());
  //計算排名獎勵
  const rankReward = allFighterTotalInvest / Math.log10(winnerList.length) * 0.177;
  _.each(winnerList, (companyId, index) => {
    const rank = index + 1;
    gainProfitHash[companyId] += Math.floor(rankReward / rank);
  });
  //將收益紀錄插入dbLog
  const logBulk = dbLog.rawCollection().initializeUnorderedBulkOp();
  _.each(gainProfitHash, (reward, companyId) => {
    logBulk.insert({
      logType: '亂鬥營利',
      companyId: companyId,
      data: {
        reward
      },
      createdAt: new Date()
    });
    dbCompanies.update(companyId, {
      $inc: {
        profit: reward
      }
    });
  });
  logBulk.execute();
  dbArena.update(arenaId, {
    $set: {
      winnerList: winnerList,
      endDate: new Date()
    }
  });
}
export default startArenaFight;
