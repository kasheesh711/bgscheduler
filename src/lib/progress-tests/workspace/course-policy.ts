// Course IDs reviewed by the release owner from Wise names and class dates.
export const seasonalCourseIds = [
 "6a0d1c8d7ee5250e5884daaf", "6a0d1cdc7ee5250e5884e7f5", "6a28d75f408b94644e66d03a", "6a39e4a1d166ff2bee051995", "6a6496f0db75f809a033319f",
 "6a0d1903462dd8f7b43b2522", "6a0d19e287e1a9da07931ce7", "6a0d1a6d24ee4ab44cd0bedb", "6a0d1ac9462dd8f7b43b4538", "6a2fc6861afaec6c686335a7", "6a39e40b47256ea8b0779bcf", "6a3a21ffd91d8d0bbd113e8c", "6a79954aca05ae4978b11142",
];
export const regularGroupCourseIds = [
 "696e3b916ed0911451b66522", "6a378d7dcafecff277f0073d", "6a37c5d5b065003672ddd5dc", "6a4773156969c91feb94300e", "6a70c2677080221ef1c7c5d8", "6a7e9af0b6ab7568e2337268", "6a81799f735895bd3108695c", "6a8ac450ee79651b10af6da9", "6ac7246022f2e57c79998eb7",
];
export const recentClassWindowMs = 60 * 86400000;
export function courseExclusion(courseId:string,classType:string|null|undefined){
 if(seasonalCourseIds.includes(courseId))return 'Seasonal program: Progress Checks do not apply.';
 if(classType==='ONE_TO_ONE')return null;
 if(classType==='GROUP'||classType==='LIVE')return regularGroupCourseIds.includes(courseId)?null:'This group course needs an eligibility review.';
 return 'This course needs a verified class type.';
}
export function recentAttendance(at:Date|null|undefined,now=new Date()){
 return !!at&&Number.isFinite(at.getTime())&&at.getTime()>=now.getTime()-recentClassWindowMs&&at<=now;
}
